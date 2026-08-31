'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { getDataDir } = require('../runtime-paths');

const DEFAULT_SETTINGS = Object.freeze({
  version: 1,
  autopilot: Object.freeze({
    defaultMode: 'auto',
    maxIterations: 20,
    maxRuntimeMs: 3_600_000,
    supervisorCostLimit: 0,
    reconciliationIntervalMs: 30_000,
    notifyOn: Object.freeze(['DONE', 'NEED_HUMAN', 'BLOCKED']),
    receiptEnabled: true,
  }),
  routing: Object.freeze({
    enabled: false,
    preset: 'balanced',
    complexityTier: 'C1',
    thinkingTier: 'T1',
    promptPolicy: 'P1',
    modelOrder: Object.freeze([]),
    manualPin: null,
    allowFallback: false,
    autoModel: true,
    autoReasoning: true,
    respectManualPin: true,
    allowLegacyModels: false,
    showDetails: true,
    failureEscalation: true,
  }),
  safety: Object.freeze({
    permissionApproval: 'human-only',
    dangerousOperations: 'human-only',
    profileApplyFailure: 'pause',
  }),
});

const NOTIFICATION_TYPES = new Set(['DONE', 'NEED_HUMAN', 'BLOCKED', 'LOOP_DETECTED', 'STATE_DRIFT', 'IDENTITY_FAILED', 'DELIVERY_UNVERIFIED', 'PERMISSION_REQUIRED', 'PROFILE_APPLY_FAILED']);
const ROUTING_PRESETS = new Set(['quality', 'balanced', 'save', 'custom']);
function defaultPath() {
  return path.join(getDataDir(), 'autopilot-settings.json');
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function boundedInteger(value, fallback, min, max) {
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : fallback;
}

function nonNegativeNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function normalizePin(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const modelId = typeof value.modelId === 'string' ? value.modelId.trim().slice(0, 200) : '';
  const reasoningLevel = typeof value.reasoningLevel === 'string' ? value.reasoningLevel.trim().toLowerCase().slice(0, 30) : '';
  return modelId || reasoningLevel ? { modelId: modelId || null, reasoningLevel: reasoningLevel || null } : null;
}

function normalizeSettings(input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const autopilot = source.autopilot && typeof source.autopilot === 'object' && !Array.isArray(source.autopilot) ? source.autopilot : {};
  const routing = source.routing && typeof source.routing === 'object' && !Array.isArray(source.routing) ? source.routing : {};
  const safety = source.safety && typeof source.safety === 'object' && !Array.isArray(source.safety) ? source.safety : {};
  const notifyOn = Array.isArray(autopilot.notifyOn)
    ? [...new Set(autopilot.notifyOn.map((item) => String(item || '').trim().toUpperCase()).filter((item) => NOTIFICATION_TYPES.has(item)))].slice(0, 20)
    : [...DEFAULT_SETTINGS.autopilot.notifyOn];
  const modelOrder = Array.isArray(routing.modelOrder)
    ? [...new Set(routing.modelOrder.map((item) => typeof item === 'string' ? item.trim().slice(0, 200) : '').filter(Boolean))].slice(0, 50)
    : [...DEFAULT_SETTINGS.routing.modelOrder];
  const normalized = {
    version: 1,
    autopilot: {
      defaultMode: autopilot.defaultMode === 'suggest' ? 'suggest' : 'auto',
      maxIterations: boundedInteger(autopilot.maxIterations, DEFAULT_SETTINGS.autopilot.maxIterations, 1, 100),
      maxRuntimeMs: boundedInteger(autopilot.maxRuntimeMs, DEFAULT_SETTINGS.autopilot.maxRuntimeMs, 1_000, 86_400_000),
      supervisorCostLimit: nonNegativeNumber(autopilot.supervisorCostLimit, DEFAULT_SETTINGS.autopilot.supervisorCostLimit),
      reconciliationIntervalMs: boundedInteger(autopilot.reconciliationIntervalMs, DEFAULT_SETTINGS.autopilot.reconciliationIntervalMs, 1_000, 3_600_000),
      notifyOn,
      receiptEnabled: autopilot.receiptEnabled !== false,
    },
    routing: {
      enabled: routing.enabled === true,
      preset: ROUTING_PRESETS.has(routing.preset) ? routing.preset : DEFAULT_SETTINGS.routing.preset,
      complexityTier: /^C[0-3]$/.test(String(routing.complexityTier || '')) ? routing.complexityTier : DEFAULT_SETTINGS.routing.complexityTier,
      thinkingTier: /^T[0-3]$/.test(String(routing.thinkingTier || '')) ? routing.thinkingTier : DEFAULT_SETTINGS.routing.thinkingTier,
      promptPolicy: /^P[0-2]$/.test(String(routing.promptPolicy || '')) ? routing.promptPolicy : DEFAULT_SETTINGS.routing.promptPolicy,
      modelOrder,
      manualPin: normalizePin(routing.manualPin),
      allowFallback: routing.allowFallback === true,
      autoModel: routing.autoModel !== false,
      autoReasoning: routing.autoReasoning !== false,
      respectManualPin: routing.respectManualPin !== false,
      allowLegacyModels: routing.allowLegacyModels === true,
      showDetails: routing.showDetails !== false,
      failureEscalation: routing.failureEscalation !== false,
    },
    safety: {
      permissionApproval: 'human-only',
      dangerousOperations: 'human-only',
      profileApplyFailure: safety.profileApplyFailure === 'continue' ? 'continue' : 'pause',
    },
  };
  return normalized;
}

class AutoPilotSettingsStore {
  constructor(filePath = defaultPath()) {
    this.filePath = filePath;
    this.settings = clone(DEFAULT_SETTINGS);
    this.load();
  }

  load() {
    try {
      this.settings = normalizeSettings(JSON.parse(fs.readFileSync(this.filePath, 'utf8')));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.settings = normalizeSettings(DEFAULT_SETTINGS);
    }
    return this.get();
  }

  save() {
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true });
    const tempPath = this.filePath + '.tmp';
    fs.writeFileSync(tempPath, JSON.stringify(this.settings, null, 2), 'utf8');
    fs.renameSync(tempPath, this.filePath);
  }

  get() {
    return clone(this.settings);
  }

  update(patch = {}) {
    const source = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
    this.settings = normalizeSettings({
      ...this.settings,
      ...source,
      autopilot: { ...this.settings.autopilot, ...(source.autopilot || {}) },
      routing: { ...this.settings.routing, ...(source.routing || {}) },
      safety: { ...this.settings.safety, ...(source.safety || {}) },
    });
    this.save();
    return this.get();
  }

  reset() {
    this.settings = normalizeSettings(DEFAULT_SETTINGS);
    this.save();
    return this.get();
  }
}

module.exports = { AutoPilotSettingsStore, DEFAULT_SETTINGS, defaultPath, normalizeSettings };
