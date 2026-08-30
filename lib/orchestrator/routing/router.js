'use strict';

const { resolveExecutionProfile } = require('./profile');

const COMPLEXITY = ['C0', 'C1', 'C2', 'C3'];
const THINKING = ['T0', 'T1', 'T2', 'T3'];
const PROMPT_POLICIES = new Set(['P0', 'P1', 'P2']);

function normalized(value, values, fallback) {
  const candidate = String(value || '').trim().toUpperCase();
  return values.includes(candidate) ? candidate : fallback;
}

function shiftTier(tier, values, delta) {
  const index = values.indexOf(tier);
  return values[Math.max(0, Math.min(values.length - 1, index + delta))];
}

function pressure({ consecutiveFailures = 0, regression = false, stagnationCount = 0, lastRunSucceeded = false, taskSimplified = false } = {}) {
  const failures = Math.max(0, Number(consecutiveFailures) || 0);
  if (failures > 0 || regression === true || (Number(stagnationCount) || 0) > 0) {
    return { delta: Math.min(3, Math.max(1, failures) + (regression === true ? 1 : 0) + ((Number(stagnationCount) || 0) > 0 ? 1 : 0)), reasonCode: 'ROUTE_ESCALATED' };
  }
  if (lastRunSucceeded === true && taskSimplified === true) return { delta: -1, reasonCode: 'ROUTE_DOWNGRADED' };
  return { delta: 0, reasonCode: 'ROUTE_STABLE' };
}

function safePin(manualPin) {
  if (!manualPin || typeof manualPin !== 'object') return null;
  const modelId = typeof manualPin.modelId === 'string' ? manualPin.modelId.trim() : '';
  const reasoningLevel = typeof manualPin.reasoningLevel === 'string' ? manualPin.reasoningLevel.trim().toLowerCase() : '';
  return modelId || reasoningLevel ? { modelId: modelId || null, reasoningLevel: reasoningLevel || null } : null;
}

function resolveRoutingDecision({
  enabled = false,
  catalog,
  modelOrder,
  complexityTier = 'C1',
  thinkingTier = 'T1',
  promptPolicy = 'P1',
  manualPin = null,
  consecutiveFailures = 0,
  regression = false,
  stagnationCount = 0,
  lastRunSucceeded = false,
  taskSimplified = false,
  lastRouting = null,
  freshRoute = false,
  autoModel = true,
  autoReasoning = true,
  allowLegacyModels = false,
  respectManualPin = true,
  requireReasoning = true,
} = {}) {
  const active = Boolean(enabled);
  if (!active) {
    return {
      enabled: false, routeRequest: null, resolvedProfile: null, action: 'continue', reasonCode: 'ROUTING_DISABLED',
      catalog: null,
    };
  }

  if (!catalog || catalog.available === false || !Array.isArray(catalog.models)) {
    return {
      enabled: true, routeRequest: null, resolvedProfile: null, action: 'continue', reasonCode: 'ROUTING_UNAVAILABLE',
      catalog: { source: String(catalog && catalog.source || 'unavailable'), stale: Boolean(catalog && catalog.stale) },
    };
  }

  const baseComplexity = normalized(complexityTier, COMPLEXITY, 'C1');
  const baseThinking = normalized(thinkingTier, THINKING, 'T1');
  const prompt = normalized(promptPolicy, ['P0', 'P1', 'P2'], 'P1');
  const signal = freshRoute
    ? { delta: 0, reasonCode: 'ROUTE_FRESH' }
    : pressure({ consecutiveFailures, regression, stagnationCount, lastRunSucceeded, taskSimplified });
  const explicitPin = safePin(manualPin);
  const accepted = safePin(lastRouting);
  const automaticPin = {
    modelId: !autoModel && accepted ? accepted.modelId : null,
    reasoningLevel: !autoReasoning && accepted ? accepted.reasoningLevel : null,
  };
  const effectivePin = explicitPin || safePin(automaticPin);
  const request = {
    complexityTier: shiftTier(baseComplexity, COMPLEXITY, signal.delta),
    thinkingTier: shiftTier(baseThinking, THINKING, signal.delta),
    promptPolicy: PROMPT_POLICIES.has(prompt) ? prompt : 'P1',
    manualPin: effectivePin,
    trigger: signal.reasonCode,
    catalogSource: String(catalog.source || 'native'),
    catalogStale: Boolean(catalog.stale),
  };
  if (Number(consecutiveFailures) > 0 && lastRouting && lastRouting.complexityTier === 'C3') {
    return {
      enabled: true,
      routeRequest: request,
      resolvedProfile: null,
      action: 'pause',
      reasonCode: 'NEED_HUMAN_HIGHEST_TIER_FAILURE',
      catalog: requestCatalog(catalog),
    };
  }
  const resolvedProfile = resolveExecutionProfile({
    catalog,
    modelOrder: !autoModel && accepted && accepted.modelId ? [accepted.modelId] : modelOrder,
    complexityTier: request.complexityTier, thinkingTier: request.thinkingTier,
    promptPolicy: request.promptPolicy, manualPin: effectivePin,
    allowLegacyModels, requireReasoning,
  });
  if (resolvedProfile.reasonCode === 'MANUAL_PIN_UNAVAILABLE') {
    return { enabled: true, routeRequest: request, resolvedProfile, action: 'pause', reasonCode: resolvedProfile.reasonCode, catalog: requestCatalog(catalog) };
  }
  if (resolvedProfile.reasonCode !== 'PROFILE_RESOLVED') {
    return { enabled: true, routeRequest: request, resolvedProfile: null, action: 'continue', reasonCode: 'ROUTING_UNAVAILABLE', catalog: requestCatalog(catalog) };
  }
  const reasonCode = explicitPin ? 'MANUAL_PIN' : signal.reasonCode;
  const safeResolvedProfile = explicitPin || !resolvedProfile.manualPin
    ? resolvedProfile
    : Object.fromEntries(Object.entries(resolvedProfile).filter(([key]) => key !== 'manualPin'));
  return { enabled: true, routeRequest: request, resolvedProfile: safeResolvedProfile, action: 'apply', reasonCode, catalog: requestCatalog(catalog) };
}

function requestCatalog(catalog) {
  return { source: String(catalog && catalog.source || 'native'), stale: Boolean(catalog && catalog.stale) };
}

module.exports = { resolveRoutingDecision };
