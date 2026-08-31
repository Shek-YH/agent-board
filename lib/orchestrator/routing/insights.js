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

const MAX_FLYWHEEL_RECORDS = 5_000;

function agentName(value) {
  return text(value, 40).toLowerCase();
}

function aggregateOutcomeRecords({ dispatchRecords = [], includeAgent = false } = {}) {
  const profiles = new Map();
  let totalAttempts = 0;
  let totalSuccesses = 0;
  let totalFailures = 0;
  for (const record of Array.isArray(dispatchRecords) ? dispatchRecords : []) {
    const agent = includeAgent ? agentName(record && record.agent) : '';
    const routing = record && record.routing;
    const modelId = text(routing && routing.modelId, 200);
    const reasoningLevel = text(routing && routing.reasoningLevel, 30).toLowerCase();
    if ((includeAgent && !agent) || !modelId || !reasoningLevel) continue;
    const success = record.state === 'committed';
    const failure = record.state === 'failed' || record.state === 'reconcile_required';
    if (!success && !failure) continue;
    const key = includeAgent ? `${agent}\u0000${profileKey(modelId, reasoningLevel)}` : profileKey(modelId, reasoningLevel);
    const current = profiles.get(key) || {
      ...(includeAgent ? { agent } : {}), modelId, reasoningLevel, attempts: 0, successes: 0, failures: 0,
    };
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

function aggregateRoutingOutcomes({ dispatchRecords = [] } = {}) {
  return aggregateOutcomeRecords({ dispatchRecords });
}

function aggregateWorkspaceRoutingOutcomes({ dispatchRecords = [], workflows = [], maxRecords = MAX_FLYWHEEL_RECORDS } = {}) {
  const workflowAgents = new Map((Array.isArray(workflows) ? workflows : [])
    .map((workflow) => [text(workflow && workflow.id, 200), agentName(workflow && workflow.agent)])
    .filter(([id, agent]) => id && agent));
  const limit = Number.isInteger(maxRecords) && maxRecords > 0
    ? Math.min(maxRecords, MAX_FLYWHEEL_RECORDS) : MAX_FLYWHEEL_RECORDS;
  const safeRecords = (Array.isArray(dispatchRecords) ? dispatchRecords : [])
    .map((record) => {
      if (!record || typeof record !== 'object') return null;
      const agent = workflowAgents.get(text(record.workflowId, 200));
      if (!agent) return null;
      return { state: record.state, routing: record.routing, agent };
    })
    .filter(Boolean)
    .slice(-limit);
  const outcomes = aggregateOutcomeRecords({ dispatchRecords: safeRecords, includeAgent: true });
  const agents = new Map();
  for (const profile of outcomes.profiles) {
    const current = agents.get(profile.agent) || { agent: profile.agent, attempts: 0, successes: 0, failures: 0 };
    current.attempts += profile.attempts;
    current.successes += profile.successes;
    current.failures += profile.failures;
    agents.set(profile.agent, current);
  }
  return {
    totalAttempts: outcomes.totalAttempts,
    totalSuccesses: outcomes.totalSuccesses,
    totalFailures: outcomes.totalFailures,
    agents: [...agents.values()].map((summary) => ({
      ...summary, successRate: summary.attempts ? summary.successes / summary.attempts : 0,
    })),
    profiles: outcomes.profiles,
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

module.exports = {
  aggregateRoutingOutcomes,
  aggregateWorkspaceRoutingOutcomes,
  recommendExecutionProfile,
  checkRoutingWorkspace,
};
