'use strict';

function text(value, max = 200) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function safeCount(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function safeRoutingSummary(summary = {}) {
  if (!summary || typeof summary !== 'object') return null;
  return {
    enabled: summary.enabled === true,
    action: text(summary.action, 30),
    reasonCode: text(summary.reasonCode, 80),
    complexityTier: text(summary.complexityTier, 10),
    thinkingTier: text(summary.thinkingTier, 10),
    promptPolicy: text(summary.promptPolicy, 10),
    modelId: text(summary.modelId, 200),
    reasoningLevel: text(summary.reasoningLevel, 30).toLowerCase(),
    source: text(summary.source, 40),
    verified: summary.verified === true,
    fallbackApplied: summary.fallbackApplied === true,
    catalogSource: text(summary.catalogSource, 40),
    catalogStale: summary.catalogStale === true,
  };
}

function safeTimelineEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const route = entry.route || {};
  const profile = entry.profile || {};
  const catalog = entry.catalog || {};
  return {
    generatedAt: text(entry.generatedAt, 40),
    event: text(entry.event, 80),
    action: text(route.action, 30),
    reasonCode: text(route.reasonCode, 80),
    complexityTier: text(route.complexityTier, 10),
    thinkingTier: text(route.thinkingTier, 10),
    promptPolicy: text(route.promptPolicy, 10),
    modelId: text(profile.modelId, 200),
    reasoningLevel: text(profile.reasoningLevel, 30).toLowerCase(),
    source: text(profile.source, 40),
    verified: profile.verified === true,
    fallbackApplied: profile.fallbackApplied === true,
    catalogSource: text(catalog.source, 40),
    catalogStale: catalog.stale === true,
    fingerprint: text(entry.fingerprint, 64),
  };
}

function buildRoutingTimeline(workflow) {
  if (!workflow || !Array.isArray(workflow.routingAudit)) return [];
  return workflow.routingAudit.map(safeTimelineEntry).filter(Boolean);
}

function buildRoutingDiagnostics({ workflow, catalog = null, supportedAgents = [] } = {}) {
  const agent = text(workflow && workflow.agent, 40).toLowerCase();
  const supported = Array.isArray(supportedAgents)
    && supportedAgents.some((item) => text(item, 40).toLowerCase() === agent);
  const models = catalog && Array.isArray(catalog.models) ? catalog.models : [];
  const config = workflow && workflow.routingConfig && typeof workflow.routingConfig === 'object'
    ? workflow.routingConfig : {};
  const manualPin = config.manualPin && typeof config.manualPin === 'object'
    ? {
      modelId: text(config.manualPin.modelId, 200) || null,
      reasoningLevel: text(config.manualPin.reasoningLevel, 30).toLowerCase() || null,
    }
    : null;
  return {
    workflowId: text(workflow && workflow.id, 100),
    agent,
    compatibility: { supported, reasonCode: supported ? 'SUPPORTED' : 'ROUTING_AGENT_UNSUPPORTED' },
    routing: {
      enabled: config.enabled === true,
      preset: text(config.preset, 20) || 'balanced',
      manualPin,
      showDetails: config.showDetails !== false,
    },
    catalog: {
      source: text(catalog && catalog.source, 40) || 'unavailable',
      available: catalog && catalog.available === true,
      stale: catalog && catalog.stale === true,
      reasonCode: text(catalog && catalog.reasonCode, 80) || null,
      agentVersion: text(catalog && catalog.agentVersion, 100) || null,
      fetchedAt: Number.isFinite(Number(catalog && catalog.fetchedAt)) ? Number(catalog.fetchedAt) : null,
      modelCount: models.length,
    },
    lastRoute: safeRoutingSummary(workflow && workflow.lastRouting),
    counters: {
      routingEscalations: safeCount(workflow && workflow.routingEscalations),
      routingDowngrades: safeCount(workflow && workflow.routingDowngrades),
    },
  };
}

function buildRoutingUsage(workflow) {
  const limit = Number(workflow && workflow.runContract && workflow.runContract.budget && workflow.runContract.budget.supervisorCostLimit);
  const used = Number(workflow && workflow.supervisorCostUsed);
  const quota = Number.isFinite(limit) && limit > 0 && Number.isFinite(used) && used >= 0
    ? { available: true, source: 'run_contract', unit: 'supervisor_cost', used, limit, remaining: Math.max(0, limit - used) }
    : { available: false, reasonCode: 'QUOTA_DATA_UNAVAILABLE' };
  return {
    cost: { available: false, reasonCode: 'COST_DATA_UNAVAILABLE' },
    quota,
    counters: {
      routingEscalations: safeCount(workflow && workflow.routingEscalations),
      routingDowngrades: safeCount(workflow && workflow.routingDowngrades),
    },
  };
}

function buildSafeReceipt(workflow) {
  const receipt = workflow && workflow.runReceipt;
  if (!receipt || typeof receipt !== 'object') return null;
  const safe = {
    version: safeCount(receipt.version),
    runId: text(receipt.runId, 100),
    agent: text(receipt.agent, 40),
    goal: text(receipt.goal, 20_000),
    iterations: safeCount(receipt.iterations),
    dod: {
      passed: safeCount(receipt.dod && receipt.dod.passed),
      total: safeCount(receipt.dod && receipt.dod.total),
    },
    finalState: text(receipt.finalState, 30),
    stopReason: text(receipt.stopReason, 200) || null,
    counters: {
      consecutiveFailures: safeCount(receipt.counters && receipt.counters.consecutiveFailures),
      stagnation: safeCount(receipt.counters && receipt.counters.stagnation),
      dispatchFailures: safeCount(receipt.counters && receipt.counters.dispatchFailures),
      routingEscalations: safeCount(receipt.counters && receipt.counters.routingEscalations),
      routingDowngrades: safeCount(receipt.counters && receipt.counters.routingDowngrades),
    },
    routing: safeRoutingSummary(receipt.routing),
    generatedAt: text(receipt.generatedAt, 40),
  };
  return safe;
}

module.exports = {
  buildRoutingDiagnostics,
  buildRoutingTimeline,
  buildRoutingUsage,
  buildSafeReceipt,
};
