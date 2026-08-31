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
const TASK_CLASSES = new Set(['new', 'existing', 'existing_unversioned']);

function agentName(value) {
  return text(value, 40).toLowerCase();
}

function taskClass(value) {
  const normalized = text(value, 40).toLowerCase();
  return TASK_CLASSES.has(normalized) ? normalized : 'unknown';
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : 0;
}

function finiteValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function flywheelLimit(value) {
  return Number.isInteger(value) && value > 0 ? Math.min(value, MAX_FLYWHEEL_RECORDS) : MAX_FLYWHEEL_RECORDS;
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

function aggregateWorkspaceRoutingOutcomes({ dispatchRecords = [], workflows = [], events = [], maxRecords = MAX_FLYWHEEL_RECORDS } = {}) {
  const workflowAgents = new Map((Array.isArray(workflows) ? workflows : [])
    .map((workflow) => [text(workflow && workflow.id, 200), agentName(workflow && workflow.agent)])
    .filter(([id, agent]) => id && agent));
  const limit = flywheelLimit(maxRecords);
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
  const taskOutcomes = aggregateHistoricalTaskOutcomes({ workflows, events, maxRecords });
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
    taskClasses: taskOutcomes.taskClasses,
    taskProfiles: taskOutcomes.taskProfiles,
  };
}

function taskOutcome(workflow, eventIndex) {
  if (!workflow || typeof workflow !== 'object' || !workflow.runReceipt || typeof workflow.runReceipt !== 'object') return null;
  const receipt = workflow.runReceipt;
  const finalState = text(receipt.finalState, 30).toUpperCase();
  if (!['DONE', 'BLOCKED', 'STOPPED'].includes(finalState)) return null;
  const agent = agentName(workflow.agent);
  if (!agent) return null;
  const dod = receipt.dod && typeof receipt.dod === 'object' ? receipt.dod : {};
  const dodTotal = nonNegativeInteger(dod.total);
  const dodPassed = Math.min(nonNegativeInteger(dod.passed), dodTotal);
  const routing = receipt.routing && typeof receipt.routing === 'object' ? receipt.routing : workflow.lastRouting;
  const modelId = text(routing && routing.modelId, 200);
  const reasoningValue = text(routing && routing.reasoningLevel, 30).toLowerCase();
  const workflowId = text(workflow.id, 200);
  const events = eventIndex.get(workflowId) || [];
  const stopReason = text(receipt.stopReason || workflow.stopReason, 200).toLowerCase();
  const humanIntervention = events.some((event) => text(event && event.type, 60).toLowerCase() === 'takeover')
    || stopReason === 'need human' || text(workflow.controlOwner, 40).toLowerCase() === 'human';
  const startedAt = finiteValue(workflow.startedAt);
  const endedAt = finiteValue(workflow.endedAt);
  return {
    agent,
    taskClass: taskClass(workflow.classification && workflow.classification.kind),
    modelId,
    reasoningLevel: reasoningValue || null,
    iterations: nonNegativeInteger(receipt.iterations ?? workflow.runCount),
    durationMs: startedAt !== null && endedAt !== null && endedAt >= startedAt ? endedAt - startedAt : null,
    dodCompletionRate: dodTotal ? dodPassed / dodTotal : null,
    humanIntervention,
    stagnation: nonNegativeInteger((receipt.counters && receipt.counters.stagnation) ?? workflow.stagnationCount),
    success: finalState === 'DONE' && dodTotal > 0 && dodPassed >= dodTotal,
  };
}

function addTaskMetric(map, key, outcome, includeProfile) {
  const current = map.get(key) || {
    agent: outcome.agent, taskClass: outcome.taskClass,
    ...(includeProfile ? { modelId: outcome.modelId, reasoningLevel: outcome.reasoningLevel } : {}),
    attempts: 0, successes: 0, failures: 0, iterationsTotal: 0, durationTotal: 0, durationCount: 0,
    dodRateTotal: 0, dodRateCount: 0, humanInterventions: 0, stagnationTotal: 0,
  };
  current.attempts += 1;
  if (outcome.success) current.successes += 1;
  else current.failures += 1;
  current.iterationsTotal += outcome.iterations;
  if (outcome.durationMs !== null) { current.durationTotal += outcome.durationMs; current.durationCount += 1; }
  if (outcome.dodCompletionRate !== null) { current.dodRateTotal += outcome.dodCompletionRate; current.dodRateCount += 1; }
  if (outcome.humanIntervention) current.humanInterventions += 1;
  current.stagnationTotal += outcome.stagnation;
  map.set(key, current);
}

function publicTaskMetric(summary) {
  return {
    agent: summary.agent,
    taskClass: summary.taskClass,
    ...(Object.prototype.hasOwnProperty.call(summary, 'modelId')
      ? { modelId: summary.modelId, reasoningLevel: summary.reasoningLevel } : {}),
    attempts: summary.attempts,
    successes: summary.successes,
    failures: summary.failures,
    successRate: summary.attempts ? summary.successes / summary.attempts : 0,
    averageIterations: summary.attempts ? summary.iterationsTotal / summary.attempts : 0,
    averageDurationMs: summary.durationCount ? summary.durationTotal / summary.durationCount : null,
    averageDodCompletionRate: summary.dodRateCount ? summary.dodRateTotal / summary.dodRateCount : null,
    humanInterventions: summary.humanInterventions,
    averageStagnation: summary.attempts ? summary.stagnationTotal / summary.attempts : 0,
  };
}

function aggregateHistoricalTaskOutcomes({ workflows = [], events = [], maxRecords = MAX_FLYWHEEL_RECORDS } = {}) {
  const eventIndex = new Map();
  for (const event of Array.isArray(events) ? events : []) {
    const workflowId = text(event && event.workflowId, 200);
    if (!workflowId) continue;
    const current = eventIndex.get(workflowId) || [];
    current.push({ type: text(event.type, 60) });
    eventIndex.set(workflowId, current);
  }
  const taskClasses = new Map();
  const taskProfiles = new Map();
  for (const workflow of (Array.isArray(workflows) ? workflows : []).slice(-flywheelLimit(maxRecords))) {
    const outcome = taskOutcome(workflow, eventIndex);
    if (!outcome) continue;
    addTaskMetric(taskClasses, `${outcome.agent}\u0000${outcome.taskClass}`, outcome, false);
    if (outcome.modelId) {
      addTaskMetric(taskProfiles, `${outcome.agent}\u0000${outcome.taskClass}\u0000${profileKey(outcome.modelId, outcome.reasoningLevel)}`, outcome, true);
    }
  }
  return {
    taskClasses: [...taskClasses.values()].map(publicTaskMetric),
    taskProfiles: [...taskProfiles.values()].map(publicTaskMetric),
  };
}

function recommendHistoricalProfile({
  catalog, modelOrder, agent, taskClass: requestedTaskClass, taskProfiles = [], minAttempts = 3,
  complexityTier = 'C1', thinkingTier = 'T1', promptPolicy = 'P1', manualPin = null,
} = {}) {
  const minimum = Number.isInteger(minAttempts) && minAttempts > 0 ? minAttempts : 3;
  const expectedAgent = agentName(agent);
  const expectedTaskClass = taskClass(requestedTaskClass);
  const scoped = (Array.isArray(taskProfiles) ? taskProfiles : [])
    .filter((item) => agentName(item && item.agent) === expectedAgent
      && taskClass(item && item.taskClass) === expectedTaskClass);
  const sampleSize = scoped.reduce((total, item) => total + nonNegativeInteger(item && item.attempts), 0);
  const eligible = scoped.filter((item) => nonNegativeInteger(item.attempts) >= minimum);
  if (!eligible.length) return { profile: null, reasonCode: 'INSUFFICIENT_HISTORY', sampleSize, minAttempts: minimum };
  return {
    ...recommendExecutionProfile({
      catalog, modelOrder, complexityTier, thinkingTier, promptPolicy, manualPin,
      outcomes: { profiles: eligible },
    }),
    sampleSize,
    minAttempts: minimum,
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
  aggregateHistoricalTaskOutcomes,
  aggregateWorkspaceRoutingOutcomes,
  recommendHistoricalProfile,
  recommendExecutionProfile,
  checkRoutingWorkspace,
};
