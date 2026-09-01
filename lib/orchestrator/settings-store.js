'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { getDataDir } = require('../runtime-paths');

const DEFAULT_SETTINGS = Object.freeze({
  version: 1,
  autopilot: Object.freeze({
    defaultMode: 'auto',
    defaultModel: 'auto',
    defaultReasoning: 'auto',
    modelRoutingEnabled: false,
    routingPreset: 'balanced',
    maxIterations: 20,
    maxRuntimeMs: 3_600_000,
    maxBudget: 0,
    stagnationThreshold: 2,
    failureThreshold: 3,
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
    allowTests: true,
    allowedCommands: Object.freeze(['node --test', 'npm test']),
    allowGit: true,
    allowedGitOperations: Object.freeze(['status', 'diff', 'branch', 'log']),
    allowExternalSideEffects: false,
    allowSecrets: false,
    allowNetwork: false,
    allowedNetworkDomains: Object.freeze([]),
    allowInstall: false,
    allowGitPush: false,
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

function safeModel(value, fallback) {
  const normalized = typeof value === 'string' ? value.trim().slice(0, 200) : '';
  return normalized || fallback;
}

function safeStringList(value, fallback = [], maxItems = 100, maxLength = 200) {
  if (!Array.isArray(value)) return [...fallback];
  return [...new Set(value.map((item) => typeof item === 'string' ? item.trim().slice(0, maxLength) : '').filter(Boolean))].slice(0, maxItems);
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
  const autopilotModelRoutingEnabled = typeof autopilot.modelRoutingEnabled === 'boolean'
    ? autopilot.modelRoutingEnabled : routing.enabled === true;
  const modelRoutingEnabled = typeof routing.enabled === 'boolean'
    ? routing.enabled : autopilotModelRoutingEnabled;
  const notifyOn = Array.isArray(autopilot.notifyOn)
    ? [...new Set(autopilot.notifyOn.map((item) => String(item || '').trim().toUpperCase()).filter((item) => NOTIFICATION_TYPES.has(item)))].slice(0, 20)
    : [...DEFAULT_SETTINGS.autopilot.notifyOn];
  const modelOrder = Array.isArray(routing.modelOrder)
    ? [...new Set(routing.modelOrder.map((item) => typeof item === 'string' ? item.trim().slice(0, 200) : '').filter(Boolean))].slice(0, 50)
    : [...DEFAULT_SETTINGS.routing.modelOrder];
  const normalized = {
    version: 1,
    autopilot: {
      defaultMode: ['suggest', 'auto', 'guarded'].includes(autopilot.defaultMode) ? autopilot.defaultMode : 'auto',
      defaultModel: safeModel(autopilot.defaultModel, DEFAULT_SETTINGS.autopilot.defaultModel),
      defaultReasoning: safeModel(autopilot.defaultReasoning, DEFAULT_SETTINGS.autopilot.defaultReasoning),
      modelRoutingEnabled: autopilotModelRoutingEnabled,
      routingPreset: ROUTING_PRESETS.has(autopilot.routingPreset) ? autopilot.routingPreset : (ROUTING_PRESETS.has(routing.preset) ? routing.preset : DEFAULT_SETTINGS.autopilot.routingPreset),
      maxIterations: boundedInteger(autopilot.maxIterations, DEFAULT_SETTINGS.autopilot.maxIterations, 1, 100),
      maxRuntimeMs: boundedInteger(autopilot.maxRuntimeMs, DEFAULT_SETTINGS.autopilot.maxRuntimeMs, 1_000, 86_400_000),
      maxBudget: nonNegativeNumber(autopilot.maxBudget, DEFAULT_SETTINGS.autopilot.maxBudget),
      stagnationThreshold: boundedInteger(autopilot.stagnationThreshold, DEFAULT_SETTINGS.autopilot.stagnationThreshold, 1, 20),
      failureThreshold: boundedInteger(autopilot.failureThreshold, DEFAULT_SETTINGS.autopilot.failureThreshold, 1, 20),
      supervisorCostLimit: nonNegativeNumber(autopilot.supervisorCostLimit, DEFAULT_SETTINGS.autopilot.supervisorCostLimit),
      reconciliationIntervalMs: boundedInteger(autopilot.reconciliationIntervalMs, DEFAULT_SETTINGS.autopilot.reconciliationIntervalMs, 1_000, 3_600_000),
      notifyOn,
      receiptEnabled: autopilot.receiptEnabled !== false,
    },
    routing: {
      enabled: modelRoutingEnabled,
      modelRoutingEnabled,
      preset: ROUTING_PRESETS.has(routing.preset) ? routing.preset : (ROUTING_PRESETS.has(autopilot.routingPreset) ? autopilot.routingPreset : DEFAULT_SETTINGS.routing.preset),
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
      allowTests: safety.allowTests !== false,
      allowedCommands: safeStringList(safety.allowedCommands, DEFAULT_SETTINGS.safety.allowedCommands, 100, 200),
      allowGit: safety.allowGit !== false,
      allowedGitOperations: safeStringList(safety.allowedGitOperations, DEFAULT_SETTINGS.safety.allowedGitOperations, 30, 40),
      allowExternalSideEffects: safety.allowExternalSideEffects === true,
      allowSecrets: safety.allowSecrets === true,
      allowNetwork: safety.allowNetwork === true,
      allowedNetworkDomains: safeStringList(safety.allowedNetworkDomains, DEFAULT_SETTINGS.safety.allowedNetworkDomains, 100, 253),
      allowInstall: safety.allowInstall === true,
      allowGitPush: safety.allowGitPush === true,
      profileApplyFailure: safety.profileApplyFailure === 'continue' ? 'continue' : 'pause',
    },
  };
  return normalized;
}

function snapshotHash(snapshot) {
  return crypto.createHash('sha256').update(JSON.stringify(normalizeSettings(snapshot)), 'utf8').digest('hex');
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function createSettingsSnapshot(input = {}, now = Date.now) {
  const normalized = normalizeSettings(input);
  const capturedAt = typeof now === 'function' ? now() : now;
  const snapshot = {
    ...normalized,
    snapshotId: `ss-${crypto.randomUUID()}`,
    capturedAt: Number.isFinite(capturedAt) ? capturedAt : Date.now(),
  };
  snapshot.snapshotHash = snapshotHash(snapshot);
  return deepFreeze(snapshot);
}

function normalizeSettingsSnapshot(input = {}) {
  const normalized = normalizeSettings(input);
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const snapshot = {
    ...normalized,
    snapshotId: /^ss-[a-f0-9-]{8,80}$/i.test(String(source.snapshotId || '')) ? String(source.snapshotId) : `ss-${crypto.randomUUID()}`,
    capturedAt: Number.isFinite(source.capturedAt) ? source.capturedAt : Date.now(),
  };
  const computedHash = snapshotHash(snapshot);
  if (source.snapshotHash && source.snapshotHash !== computedHash) throw new TypeError('settings snapshot hash is invalid');
  snapshot.snapshotHash = computedHash;
  return deepFreeze(snapshot);
}

function verifySettingsSnapshot(snapshot) {
  return Boolean(snapshot && snapshot.snapshotHash === snapshotHash(snapshot));
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

module.exports = { AutoPilotSettingsStore, DEFAULT_SETTINGS, createSettingsSnapshot, defaultPath, normalizeSettings, normalizeSettingsSnapshot, verifySettingsSnapshot };
