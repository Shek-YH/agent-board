'use strict';

const { isInsideRoot } = require('../project-lifecycle');
const { findModel } = require('./catalog');
const { resolveExecutionProfile } = require('./profile');

function text(value, max = 200) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function profileKey(modelId, reasoningLevel) {
  return `${text(modelId, 200)}\u0000${text(reasoningLevel, 30).toLowerCase()}`;
}

function aggregateRoutingOutcomes({ dispatchRecords = [] } = {}) {
  const profiles = new Map();
  let totalAttempts = 0;
  let totalSuccesses = 0;
  let totalFailures = 0;
  for (const record of Array.isArray(dispatchRecords) ? dispatchRecords : []) {
    const routing = record && record.routing;
    const modelId = text(routing && routing.modelId, 200);
    const reasoningLevel = text(routing && routing.reasoningLevel, 30).toLowerCase();
    if (!modelId || !reasoningLevel) continue;
    const success = record.state === 'committed';
    const failure = record.state === 'failed' || record.state === 'reconcile_required';
    if (!success && !failure) continue;
    const key = profileKey(modelId, reasoningLevel);
    const current = profiles.get(key) || { modelId, reasoningLevel, attempts: 0, successes: 0, failures: 0 };
    current.attempts += 1;
    if (success) { current.successes += 1; totalSuccesses += 1; }
    if (failure) { current.failures += 1; totalFailures += 1; }
    totalAttempts += 1;
    profiles.set(key, current);
  }
  return {
    totalAttempts, totalSuccesses, totalFailures,
    profiles: [...profiles.values()].map((profile) => ({
      ...profile, successRate: profile.attempts ? profile.successes / profile.attempts : 0,
    })),
  };
}

function recommendExecutionProfile({
  catalog, modelOrder, complexityTier = 'C1', thinkingTier = 'T1', promptPolicy = 'P1', manualPin = null, outcomes = {},
} = {}) {
  const base = resolveExecutionProfile({ catalog, modelOrder, complexityTier, thinkingTier, promptPolicy, manualPin });
  if (manualPin && (manualPin.modelId || manualPin.reasoningLevel)) {
    return { profile: base, reasonCode: base.reasonCode === 'PROFILE_RESOLVED' ? 'MANUAL_PIN' : base.reasonCode };
  }
  if (!catalog || catalog.available !== true || !Array.isArray(catalog.models)) {
    return { profile: null, reasonCode: 'ROUTING_UNAVAILABLE' };
  }
  if (base.reasonCode !== 'PROFILE_RESOLVED') {
    return { profile: base, reasonCode: base.reasonCode || 'ROUTING_UNAVAILABLE' };
  }

  const stats = new Map((Array.isArray(outcomes.profiles) ? outcomes.profiles : [])
    .map((item) => [profileKey(item.modelId, item.reasoningLevel), item]));
  const candidates = [...new Set(Array.isArray(modelOrder) ? modelOrder : [])]
    .map((id) => findModel(catalog, id)).filter(Boolean);
  const scored = candidates.map((model, order) => {
    const profile = resolveExecutionProfile({
      catalog, modelOrder: [model.id], complexityTier: 'C3', thinkingTier, promptPolicy,
    });
    const item = stats.get(profileKey(profile.modelId, profile.reasoningLevel));
    return { model, profile, order, attempts: Number(item && item.attempts) || 0, successRate: Number(item && item.successRate) || 0 };
  }).filter((item) => item.profile.reasonCode === 'PROFILE_RESOLVED' && item.attempts > 0);
  if (!scored.length) return { profile: base, reasonCode: 'NO_HISTORICAL_PROFILE' };
  scored.sort((left, right) => right.successRate - left.successRate || right.attempts - left.attempts || left.order - right.order);
  const selected = scored[0].profile;
  const profile = { ...selected, complexityTier: base.complexityTier, thinkingTier: base.thinkingTier, promptPolicy: base.promptPolicy };
  const changed = profile.modelId !== base.modelId || profile.reasoningLevel !== base.reasoningLevel;
  return { profile, reasonCode: changed ? 'HISTORICAL_PROFILE_RECOMMENDED' : 'HISTORICAL_PROFILE_STABLE' };
}

function checkRoutingWorkspace({ projectPath, allowedRoots = [] } = {}) {
  const project = text(projectPath, 1_000);
  const roots = Array.isArray(allowedRoots) ? allowedRoots.filter((root) => typeof root === 'string' && root.trim()) : [];
  if (!project) return { safe: false, reasonCode: 'WORKSPACE_PATH_MISSING' };
  if (!roots.length) return { safe: false, reasonCode: 'WORKSPACE_ROOTS_UNCONFIGURED' };
  return roots.some((root) => isInsideRoot(project, root))
    ? { safe: true, reasonCode: 'WORKSPACE_IN_SCOPE' }
    : { safe: false, reasonCode: 'WORKSPACE_OUT_OF_SCOPE' };
}

module.exports = { aggregateRoutingOutcomes, recommendExecutionProfile, checkRoutingWorkspace };
