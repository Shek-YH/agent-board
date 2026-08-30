'use strict';

const { createCatalogReader } = require('./catalog-store');
const { resolveRoutingDecision } = require('./router');
const { applyAndVerifyProfile } = require('./profile-runtime');
const { buildRoutingAuditEvent } = require('./audit');

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
    showDetails: input.showDetails !== false,
  };
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
    nativeReader: capability, cachePath, ttlMs, now, agentVersion,
  })]));
  const readerFor = (agent) => catalogReaders.get(String(agent || '').trim().toLowerCase()) || null;

  return {
    supportedAgents() {
      return [...capabilities.keys()];
    },
    async getCatalog({ agent = 'codex' } = {}) {
      const reader = readerFor(agent);
      return reader ? reader.read() : {
        source: 'unavailable', models: [], available: false, stale: false, reasonCode: 'CATALOG_UNAVAILABLE',
      };
    },
    async prepare({ workflow, progress = {}, dependencies = null } = {}) {
      const config = normalizeRoutingConfig(workflow && workflow.routingConfig);
      if (!config.enabled) return null;
      const agent = String(workflow && workflow.agent || '').trim().toLowerCase();
      const capability = capabilities.get(agent);
      const reader = readerFor(agent);
      const catalog = reader ? await reader.read() : null;
      if (!reader) {
        const decision = unsupportedDecision(catalog);
        return { decision, profileResult: null, auditEvent: buildRoutingAuditEvent({ event: 'routing_skipped', routeDecision: decision }) };
      }
      const modelOrder = config.modelOrder.length ? config.modelOrder : catalog.models.map((model) => model.id);
      const decision = resolveRoutingDecision({
        enabled: true,
        catalog,
        modelOrder,
        complexityTier: config.complexityTier,
        thinkingTier: config.thinkingTier,
        promptPolicy: config.promptPolicy,
        manualPin: config.manualPin,
        consecutiveFailures: workflow.consecutiveFailures,
        regression: progress.regression === true,
        stagnationCount: workflow.stagnationCount,
        lastRunSucceeded: Number(workflow.runCount || 0) > 0 && Number(workflow.consecutiveFailures || 0) === 0,
        taskSimplified: workflow.taskSimplified === true,
        lastRouting: workflow.lastRouting,
      });
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
      };
    },
  };
}

module.exports = { PRESETS, createRoutingRuntime, normalizeRoutingConfig };
