'use strict';

const path = require('node:path');
const { createCatalogReader, DEFAULT_CACHE_PATH } = require('./catalog-store');
const { resolveRoutingDecision } = require('./router');
const { applyAndVerifyProfile } = require('./profile-runtime');
const { buildRoutingAuditEvent } = require('./audit');
const { resolveExecutionProfile } = require('./profile');

const PRESETS = {
  quality: { complexityTier: 'C3', thinkingTier: 'T3', promptPolicy: 'P2' },
  balanced: { complexityTier: 'C1', thinkingTier: 'T1', promptPolicy: 'P1' },
  save: { complexityTier: 'C0', thinkingTier: 'T0', promptPolicy: 'P0' },
};

function text(value, max = 200) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function tier(value, fallback, prefix, max) {
  const candidate = text(value, 10).toUpperCase();
  return new RegExp(`^${prefix}[0-${max}]$`).test(candidate) ? candidate : fallback;
}

function normalizePin(value) {
  if (!value || typeof value !== 'object') return null;
  const modelId = text(value.modelId, 200);
  const reasoningLevel = text(value.reasoningLevel, 30).toLowerCase();
  return modelId || reasoningLevel ? { modelId: modelId || null, reasoningLevel: reasoningLevel || null } : null;
}

function cachePathForAgent(cachePath, agent) {
  const value = String(cachePath || DEFAULT_CACHE_PATH);
  if (String(agent || '').toLowerCase() === 'codex') return value;
  const extension = path.extname(value);
  const stem = extension ? value.slice(0, -extension.length) : value;
  return `${stem}-${String(agent).toLowerCase()}${extension}`;
}

function capabilityStatus(capability) {
  const discovery = Boolean(capability && (typeof capability.listModels === 'function' || typeof capability.getModelCatalog === 'function'));
  const modelSwitch = Boolean(capability && (typeof capability.applyProfile === 'function' || typeof capability.applyModel === 'function'));
  const reasoning = Boolean(capability && capability.supportsReasoning !== false && typeof capability.applyProfile === 'function');
  return {
    modelDiscovery: discovery,
    modelSwitch,
    reasoningControl: reasoning,
    profileVerification: Boolean(modelSwitch && (typeof capability.readProfile === 'function' || reasoning || capability.supportsReasoning === false)),
  };
}

function normalizeRoutingConfig(config = {}) {
  const input = config && typeof config === 'object' && !Array.isArray(config) ? config : {};
  const preset = ['quality', 'balanced', 'save', 'custom'].includes(input.preset) ? input.preset : 'balanced';
  const selected = preset === 'custom' ? {
    complexityTier: tier(input.complexityTier, 'C1', 'C', 3),
    thinkingTier: tier(input.thinkingTier, 'T1', 'T', 3),
    promptPolicy: ['P0', 'P1', 'P2'].includes(String(input.promptPolicy || '').toUpperCase())
      ? String(input.promptPolicy).toUpperCase() : 'P1',
  } : PRESETS[preset];
  return {
    enabled: input.enabled === true,
    preset,
    complexityTier: selected.complexityTier,
    thinkingTier: selected.thinkingTier,
    promptPolicy: selected.promptPolicy,
    modelOrder: Array.isArray(input.modelOrder)
      ? [...new Set(input.modelOrder.filter((item) => typeof item === 'string').map((item) => item.trim()).filter(Boolean))].slice(0, 50)
      : [],
    manualPin: normalizePin(input.manualPin),
    allowFallback: input.allowFallback === true,
    autoModel: input.autoModel !== false,
    autoReasoning: input.autoReasoning !== false,
    respectManualPin: input.respectManualPin !== false,
    allowLegacyModels: input.allowLegacyModels === true,
    showDetails: input.showDetails !== false,
  };
}

async function detectHumanPin(capability, workflow) {
  if (!capability || typeof capability !== 'object') return null;
  try {
    if (typeof capability.detectManualPin === 'function') {
      const detected = await capability.detectManualPin({ sessionRef: workflow.binding && workflow.binding.sessionRef });
      const pin = normalizePin(detected && detected.profile ? detected.profile : detected);
      if (pin && (detected.manualPin === true || detected.changedBy === 'human' || detected.source === 'human')) return pin;
    }
    if (typeof capability.readProfile === 'function' && workflow.lastRouting) {
      const current = await capability.readProfile({ sessionRef: workflow.binding && workflow.binding.sessionRef });
      const pin = normalizePin(current && current.profile ? current.profile : current);
      if (pin && (current.manualPin === true || current.changedBy === 'human' || current.source === 'human')) return pin;
    }
  } catch { /* profile drift detection is best effort; routing remains fail closed on apply verification */ }
  return null;
}

function unsupportedDecision(catalog) {
  return {
    enabled: false, routeRequest: null, resolvedProfile: null, action: 'continue', reasonCode: 'ROUTING_AGENT_UNSUPPORTED',
    catalog: { source: String(catalog && catalog.source || 'unavailable'), stale: Boolean(catalog && catalog.stale) },
  };
}

function createRoutingRuntime({
  nativeCapability = null,
  agentCapabilities = {},
  profileFallback = null,
  cachePath,
  ttlMs,
  now = () => Date.now(),
  agentVersion = null,
  onCatalogProbe = null,
} = {}) {
  const capabilities = new Map();
  capabilities.set('codex', nativeCapability);
  if (agentCapabilities && typeof agentCapabilities === 'object' && !Array.isArray(agentCapabilities)) {
    for (const [agent, capability] of Object.entries(agentCapabilities)) {
      const name = String(agent || '').trim().toLowerCase();
      if (name && capability) capabilities.set(name, capability);
    }
  }
  const catalogReaders = new Map([...capabilities.entries()].map(([agent, capability]) => [agent, createCatalogReader({
    nativeReader: capability, cachePath: cachePathForAgent(cachePath, agent), ttlMs, now, agentVersion,
  })]));
  const readerFor = (agent) => catalogReaders.get(String(agent || '').trim().toLowerCase()) || null;
  async function readCatalog(agent, reader, method = 'read') {
    const catalog = await reader[method]();
    if (typeof onCatalogProbe === 'function') {
      try { onCatalogProbe(String(agent || '').trim().toLowerCase(), catalog); } catch { /* telemetry must not affect routing */ }
    }
    return catalog;
  }

  return {
    supportedAgents() {
      return [...capabilities.keys()];
    },
    getCapabilityStatus({ agent = 'codex' } = {}) {
      return capabilityStatus(capabilities.get(String(agent || '').trim().toLowerCase()));
    },
    async getCatalog({ agent = 'codex' } = {}) {
      const reader = readerFor(agent);
      return reader ? readCatalog(agent, reader) : {
        source: 'unavailable', models: [], available: false, stale: false, reasonCode: 'CATALOG_UNAVAILABLE',
      };
    },
    async refreshCatalog({ agent = 'codex' } = {}) {
      const reader = readerFor(agent);
      return reader && typeof reader.refresh === 'function' ? readCatalog(agent, reader, 'refresh') : this.getCatalog({ agent });
    },
    async testProfile({ workflow, modelId, reasoningLevel } = {}) {
      const agent = String(workflow && workflow.agent || '').trim().toLowerCase();
      const capability = capabilities.get(agent);
      const reader = readerFor(agent);
      if (!capability || !reader) return { ok: false, code: 'ROUTING_AGENT_UNSUPPORTED', dispatchAllowed: false };
      if (!capabilityStatus(capability).modelSwitch) {
        return { ok: false, code: 'ROUTING_AGENT_UNSUPPORTED', dispatchAllowed: false };
      }
      const config = normalizeRoutingConfig(workflow.routingConfig);
      let catalog = await readCatalog(agent, reader);
      const requireReasoning = capability.supportsReasoning !== false && typeof capability.applyProfile === 'function';
      let profile = resolveExecutionProfile({
        catalog, modelOrder: [text(modelId, 200)], complexityTier: 'C3', thinkingTier: 'T3',
        promptPolicy: 'P1', manualPin: normalizePin({ modelId, reasoningLevel }),
        allowLegacyModels: config.allowLegacyModels, requireReasoning,
      });
      if (profile.reasonCode !== 'PROFILE_RESOLVED') {
        return { ok: false, code: profile.reasonCode, profile, catalog, dispatchAllowed: false };
      }
      const result = await applyAndVerifyProfile({
        native: capability, fallback: null, allowFallback: false,
        sessionRef: workflow.binding && workflow.binding.sessionRef, profile,
      });
      return {
        ok: result.ok === true, code: result.ok ? 'PROFILE_TEST_VERIFIED' : result.code,
        profile, result, catalog, dispatchAllowed: false,
        auditEvent: buildRoutingAuditEvent({
          event: result.ok ? 'model_apply_verified' : 'model_apply_failed',
          sessionRef: workflow.binding && workflow.binding.sessionRef,
          routeDecision: { enabled: true, action: 'test', reasonCode: result.ok ? 'PROFILE_TEST_VERIFIED' : result.code, routeRequest: { complexityTier: 'C3', thinkingTier: 'T3', promptPolicy: 'P1' }, resolvedProfile: profile, catalog },
          profileResult: result,
        }),
      };
    },
    async prepare({ workflow, progress = {}, dependencies = null } = {}) {
      const config = normalizeRoutingConfig(workflow && workflow.routingConfig);
      if (!config.enabled) return null;
      const agent = String(workflow && workflow.agent || '').trim().toLowerCase();
      const capability = capabilities.get(agent);
      const reader = readerFor(agent);
      let catalog = reader ? await readCatalog(agent, reader) : null;
      if (!reader) {
        const decision = unsupportedDecision(catalog);
        return { decision, profileResult: null, auditEvent: buildRoutingAuditEvent({ event: 'routing_skipped', routeDecision: decision }) };
      }
      if (capability && !capabilityStatus(capability).modelSwitch) {
        const decision = unsupportedDecision(catalog);
        return { decision, profileResult: null, auditEvent: buildRoutingAuditEvent({ event: 'routing_skipped', routeDecision: decision }) };
      }
      const detectedPin = config.respectManualPin ? await detectHumanPin(capability, workflow) : null;
      const manualPin = detectedPin || config.manualPin;
      const requireReasoning = Boolean(capability)
        && capability.supportsReasoning !== false && typeof capability.applyProfile === 'function';
      const modelOrder = config.modelOrder.length ? config.modelOrder : catalog.models.map((model) => model.id);
      let decision = resolveRoutingDecision({
        enabled: true,
        catalog,
        modelOrder,
        complexityTier: config.complexityTier,
        thinkingTier: config.thinkingTier,
        promptPolicy: config.promptPolicy,
        manualPin,
        autoModel: config.autoModel,
        autoReasoning: config.autoReasoning,
        respectManualPin: config.respectManualPin,
        allowLegacyModels: config.allowLegacyModels,
        requireReasoning,
        consecutiveFailures: workflow.consecutiveFailures,
        regression: progress.regression === true,
        stagnationCount: workflow.stagnationCount,
        lastRunSucceeded: Number(workflow.runCount || 0) > 0 && Number(workflow.consecutiveFailures || 0) === 0,
        taskSimplified: workflow.taskSimplified === true,
        lastRouting: workflow.lastRouting,
      });
      let catalogRefreshAudit = null;
      if (decision.reasonCode === 'ROUTING_UNAVAILABLE' && catalog && catalog.available === true) {
        const refreshedCatalog = await readCatalog(agent, reader, 'refresh');
        if (refreshedCatalog && refreshedCatalog.available === true) {
          catalog = refreshedCatalog;
          decision = resolveRoutingDecision({
            enabled: true,
            catalog,
            modelOrder,
            complexityTier: config.complexityTier,
            thinkingTier: config.thinkingTier,
            promptPolicy: config.promptPolicy,
            manualPin,
            autoModel: config.autoModel,
            autoReasoning: config.autoReasoning,
            respectManualPin: config.respectManualPin,
            allowLegacyModels: config.allowLegacyModels,
            requireReasoning,
            consecutiveFailures: workflow.consecutiveFailures,
            regression: progress.regression === true,
            stagnationCount: workflow.stagnationCount,
            lastRunSucceeded: Number(workflow.runCount || 0) > 0 && Number(workflow.consecutiveFailures || 0) === 0,
            taskSimplified: workflow.taskSimplified === true,
            lastRouting: workflow.lastRouting,
          });
          catalogRefreshAudit = buildRoutingAuditEvent({
            event: 'MODEL_CATALOG_REFRESHED', sessionRef: workflow.binding && workflow.binding.sessionRef,
            routeDecision: decision, now: now(),
          });
        }
      }
      let profileResult = null;
      if (decision.action === 'apply') {
        let fallback = profileFallback;
        if (typeof profileFallback === 'function') {
          try { fallback = await profileFallback({ workflow, config, dependencies }); } catch { fallback = null; }
        }
        profileResult = await applyAndVerifyProfile({
          native: capability,
          fallback,
          allowFallback: config.allowFallback,
          sessionRef: workflow.binding && workflow.binding.sessionRef,
          profile: decision.resolvedProfile,
        });
      }
      const event = profileResult
        ? (profileResult.ok ? 'profile_verified' : 'profile_verify_failed')
        : (decision.reasonCode === 'ROUTING_UNAVAILABLE' ? 'routing_unavailable' : 'routing_decision');
      return {
        decision,
        profileResult,
        auditEvent: buildRoutingAuditEvent({ event, sessionRef: workflow.binding && workflow.binding.sessionRef, routeDecision: decision, profileResult }),
        ...(catalogRefreshAudit ? { auditEvents: [catalogRefreshAudit] } : {}),
      };
    },
  };
}

module.exports = { PRESETS, createRoutingRuntime, normalizeRoutingConfig, cachePathForAgent };
