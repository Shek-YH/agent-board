'use strict';

const { normalizeEvidence } = require('./evidence');
const {
  ACTIVITY_STATES,
  ATTENTION_STATES,
  CANONICAL_DIMENSIONS,
  EVENT_TYPES,
  LIVENESS_STATES,
  SESSION_LIFECYCLE_STATES,
  TURN_STATES,
} = require('./enums');
const { arbitrateEvidence, CODEX_SOURCE_AUTHORITY_POLICY, WORKBUDDY_SOURCE_AUTHORITY_POLICY } = require('./arbitrator');
const { cloneRuntime } = require('./runtime');

/** @type {Set<string>} */
const TURN_SIGNALS = new Set([
  EVENT_TYPES.TURN_STARTED, EVENT_TYPES.TURN_COMPLETION_SIGNAL, EVENT_TYPES.TURN_COMPLETED,
  EVENT_TYPES.TURN_FAILED, EVENT_TYPES.TURN_INTERRUPTED, EVENT_TYPES.USER_MESSAGE,
  EVENT_TYPES.ASSISTANT_MESSAGE, EVENT_TYPES.TOOL_STARTED, EVENT_TYPES.TOOL_FINISHED,
  EVENT_TYPES.SUBAGENT_STARTED, EVENT_TYPES.SUBAGENT_FINISHED, EVENT_TYPES.WAITING_APPROVAL,
  EVENT_TYPES.WAITING_USER, EVENT_TYPES.WAITING_EXTERNAL, EVENT_TYPES.RATE_LIMITED,
  EVENT_TYPES.CONTEXT_COMPACTING,
]);
/** @type {Set<string>} */
const ACTIVITY_SIGNALS = new Set([
  EVENT_TYPES.TURN_STARTED, EVENT_TYPES.USER_MESSAGE, EVENT_TYPES.ASSISTANT_MESSAGE,
  EVENT_TYPES.TOOL_STARTED, EVENT_TYPES.TOOL_FINISHED, EVENT_TYPES.SUBAGENT_STARTED,
  EVENT_TYPES.SUBAGENT_FINISHED, EVENT_TYPES.WAITING_APPROVAL, EVENT_TYPES.WAITING_USER,
  EVENT_TYPES.WAITING_EXTERNAL, EVENT_TYPES.RATE_LIMITED, EVENT_TYPES.CONTEXT_COMPACTING,
  EVENT_TYPES.TURN_COMPLETED, EVENT_TYPES.TURN_FAILED, EVENT_TYPES.TURN_INTERRUPTED,
]);
/** @type {Set<string>} */
const LIFECYCLE_SIGNALS = new Set([
  EVENT_TYPES.SESSION_DISCOVERED, EVENT_TYPES.SESSION_STARTED, EVENT_TYPES.SESSION_CLOSING,
  EVENT_TYPES.SESSION_CLOSED, EVENT_TYPES.SESSION_ARCHIVED, EVENT_TYPES.PROCESS_DEAD,
]);
/** @type {Set<string>} */
const LIVENESS_SIGNALS = new Set([
  EVENT_TYPES.PROCESS_SEEN, EVENT_TYPES.PROCESS_MISSING, EVENT_TYPES.PROCESS_DEAD,
  EVENT_TYPES.HEARTBEAT,
]);
/** @type {Set<string>} */
const ATTENTION_SIGNALS = new Set([
  EVENT_TYPES.WAITING_APPROVAL, EVENT_TYPES.WAITING_USER, EVENT_TYPES.WAITING_EXTERNAL,
  EVENT_TYPES.TURN_COMPLETED, EVENT_TYPES.TURN_FAILED, EVENT_TYPES.TURN_INTERRUPTED,
  EVENT_TYPES.USER_MESSAGE, EVENT_TYPES.MANUAL_OVERRIDE,
]);

function valueField(evidence, ...fields) {
  const value = evidence.value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  for (const field of fields) {
    if (value[field] !== undefined && value[field] !== null) return String(value[field]);
  }
  return undefined;
}

function isChildEvidence(evidence) {
  const value = evidence.value;
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && (
    value.sessionRole === 'child' || value.role === 'child' || value.topology?.role === 'child'
  ));
}

function dimensionsForSignal(signal) {
  const dimensions = [];
  if (LIVENESS_SIGNALS.has(signal)) dimensions.push(CANONICAL_DIMENSIONS.LIVENESS);
  if (LIFECYCLE_SIGNALS.has(signal)) dimensions.push(CANONICAL_DIMENSIONS.SESSION_LIFECYCLE);
  if (TURN_SIGNALS.has(signal)) dimensions.push(CANONICAL_DIMENSIONS.TURN);
  if (ACTIVITY_SIGNALS.has(signal)) dimensions.push(CANONICAL_DIMENSIONS.ACTIVITY);
  if (ATTENTION_SIGNALS.has(signal)) dimensions.push(CANONICAL_DIMENSIONS.ATTENTION);
  return dimensions;
}

function policyForAgent(agent) {
  if (agent === 'workbuddy') return WORKBUDDY_SOURCE_AUTHORITY_POLICY;
  if (agent === 'codex') return CODEX_SOURCE_AUTHORITY_POLICY;
  return CODEX_SOURCE_AUTHORITY_POLICY;
}

function isWinning(runtime, evidence, dimension) {
  const candidates = runtime.recentEvidence
    .filter((item) => dimensionsForSignal(item.signalType).includes(dimension));
  const result = arbitrateEvidence(dimension, [...candidates, evidence], {
    policy: policyForAgent(evidence.agent),
    now: evidence.observedAt,
  });
  return result.winner && result.winner.evidenceId === evidence.evidenceId;
}

function openSession(runtime, patch) {
  if (patch.sessionLifecycle === undefined && runtime.sessionLifecycle === SESSION_LIFECYCLE_STATES.UNKNOWN) {
    patch.sessionLifecycle = SESSION_LIFECYCLE_STATES.OPEN;
  }
}

function applyLiveness(runtime, evidence, patch) {
  switch (evidence.signalType) {
    case EVENT_TYPES.PROCESS_SEEN:
    case EVENT_TYPES.HEARTBEAT:
      patch.liveness = LIVENESS_STATES.ALIVE;
      break;
    case EVENT_TYPES.PROCESS_MISSING:
      patch.liveness = LIVENESS_STATES.SUSPECT;
      break;
    case EVENT_TYPES.PROCESS_DEAD:
      patch.liveness = LIVENESS_STATES.DEAD;
      if (evidence.value && typeof evidence.value === 'object' && evidence.value.identityConfirmed === true) {
        patch.sessionLifecycle = SESSION_LIFECYCLE_STATES.CLOSED;
      }
      break;
    default:
      break;
  }
}

function applyLifecycle(runtime, evidence, patch) {
  switch (evidence.signalType) {
    case EVENT_TYPES.SESSION_DISCOVERED:
    case EVENT_TYPES.SESSION_STARTED:
      patch.sessionLifecycle = SESSION_LIFECYCLE_STATES.OPEN;
      break;
    case EVENT_TYPES.SESSION_CLOSING:
      patch.sessionLifecycle = SESSION_LIFECYCLE_STATES.CLOSING;
      break;
    case EVENT_TYPES.SESSION_CLOSED:
      patch.sessionLifecycle = SESSION_LIFECYCLE_STATES.CLOSED;
      break;
    case EVENT_TYPES.SESSION_ARCHIVED:
      patch.sessionLifecycle = SESSION_LIFECYCLE_STATES.ARCHIVED;
      break;
    default:
      break;
  }
}

function applyTurn(runtime, evidence, patch) {
  const signal = evidence.signalType;
  const turnId = valueField(evidence, 'turnId', 'turn_id');
  if (turnId && [EVENT_TYPES.TURN_STARTED, EVENT_TYPES.USER_MESSAGE].includes(signal)) patch.currentTurnId = turnId;
  switch (signal) {
    case EVENT_TYPES.TURN_STARTED:
    case EVENT_TYPES.USER_MESSAGE:
    case EVENT_TYPES.ASSISTANT_MESSAGE:
    case EVENT_TYPES.TOOL_STARTED:
    case EVENT_TYPES.SUBAGENT_STARTED:
    case EVENT_TYPES.WAITING_APPROVAL:
    case EVENT_TYPES.WAITING_USER:
    case EVENT_TYPES.WAITING_EXTERNAL:
    case EVENT_TYPES.RATE_LIMITED:
    case EVENT_TYPES.CONTEXT_COMPACTING:
      patch.turnState = TURN_STATES.RUNNING;
      break;
    case EVENT_TYPES.TOOL_FINISHED:
    case EVENT_TYPES.SUBAGENT_FINISHED:
      patch.turnState = runtime.turnState === TURN_STATES.COMPLETION_CANDIDATE
        ? TURN_STATES.COMPLETION_CANDIDATE : TURN_STATES.RUNNING;
      break;
    case EVENT_TYPES.TURN_COMPLETION_SIGNAL:
      patch.turnState = TURN_STATES.COMPLETION_CANDIDATE;
      break;
    case EVENT_TYPES.TURN_COMPLETED:
      patch.turnState = runtime.activeToolIds.length || runtime.activeSubagentIds.length
        ? TURN_STATES.COMPLETION_CANDIDATE : TURN_STATES.COMPLETED;
      break;
    case EVENT_TYPES.TURN_FAILED:
      patch.turnState = TURN_STATES.FAILED;
      break;
    case EVENT_TYPES.TURN_INTERRUPTED:
      patch.turnState = TURN_STATES.INTERRUPTED;
      break;
    default:
      break;
  }
}

function applyActivity(runtime, evidence, patch) {
  const signal = evidence.signalType;
  switch (signal) {
    case EVENT_TYPES.TURN_STARTED:
      patch.activityState = ACTIVITY_STATES.THINKING;
      break;
    case EVENT_TYPES.USER_MESSAGE:
      patch.activityState = ACTIVITY_STATES.PLANNING;
      break;
    case EVENT_TYPES.ASSISTANT_MESSAGE:
      patch.activityState = ACTIVITY_STATES.THINKING;
      break;
    case EVENT_TYPES.TOOL_STARTED:
      patch.activityState = valueField(evidence, 'kind', 'toolType') === 'command'
        ? ACTIVITY_STATES.RUNNING_COMMAND : ACTIVITY_STATES.USING_TOOL;
      break;
    case EVENT_TYPES.TOOL_FINISHED:
      patch.activityState = runtime.activeToolIds.length > 1
        ? ACTIVITY_STATES.USING_TOOL
        : runtime.activeSubagentIds.length ? ACTIVITY_STATES.RUNNING_SUBAGENT : ACTIVITY_STATES.IDLE;
      break;
    case EVENT_TYPES.SUBAGENT_STARTED:
      patch.activityState = ACTIVITY_STATES.RUNNING_SUBAGENT;
      break;
    case EVENT_TYPES.SUBAGENT_FINISHED:
      patch.activityState = runtime.activeSubagentIds.length > 1
        ? ACTIVITY_STATES.RUNNING_SUBAGENT
        : runtime.activeToolIds.length ? ACTIVITY_STATES.USING_TOOL : ACTIVITY_STATES.IDLE;
      break;
    case EVENT_TYPES.WAITING_APPROVAL:
      patch.activityState = ACTIVITY_STATES.WAITING_APPROVAL;
      break;
    case EVENT_TYPES.WAITING_USER:
      patch.activityState = ACTIVITY_STATES.WAITING_USER;
      break;
    case EVENT_TYPES.WAITING_EXTERNAL:
      patch.activityState = ACTIVITY_STATES.WAITING_EXTERNAL;
      break;
    case EVENT_TYPES.RATE_LIMITED:
      patch.activityState = ACTIVITY_STATES.RATE_LIMITED;
      break;
    case EVENT_TYPES.CONTEXT_COMPACTING:
      patch.activityState = ACTIVITY_STATES.COMPACTING_CONTEXT;
      break;
    case EVENT_TYPES.TURN_COMPLETED:
    case EVENT_TYPES.TURN_FAILED:
    case EVENT_TYPES.TURN_INTERRUPTED:
      patch.activityState = ACTIVITY_STATES.IDLE;
      break;
    default:
      break;
  }
}

function applyAttention(runtime, evidence, patch) {
  switch (evidence.signalType) {
    case EVENT_TYPES.WAITING_APPROVAL:
    case EVENT_TYPES.WAITING_USER:
    case EVENT_TYPES.WAITING_EXTERNAL:
      patch.attentionState = ATTENTION_STATES.ACTION_REQUIRED;
      break;
    case EVENT_TYPES.TURN_COMPLETED:
      if (runtime.activeToolIds.length === 0 && runtime.activeSubagentIds.length === 0) patch.attentionState = ATTENTION_STATES.COMPLETED_UNSEEN;
      break;
    case EVENT_TYPES.TURN_FAILED:
      patch.attentionState = ATTENTION_STATES.FAILED_UNSEEN;
      break;
    case EVENT_TYPES.TURN_INTERRUPTED:
      patch.attentionState = ATTENTION_STATES.INTERRUPTED_UNSEEN;
      break;
    case EVENT_TYPES.USER_MESSAGE:
      patch.attentionState = ATTENTION_STATES.NONE;
      break;
    case EVENT_TYPES.MANUAL_OVERRIDE:
      if (valueField(evidence, 'action') === 'mark_seen') patch.attentionState = ATTENTION_STATES.NONE;
      break;
    default:
      break;
  }
}

function applyCollection(runtime, evidence, patch) {
  const id = valueField(evidence, 'toolId', 'tool_id', 'id');
  if (evidence.signalType === EVENT_TYPES.TOOL_STARTED && id) patch.activeToolIds = [...runtime.activeToolIds, id];
  if (evidence.signalType === EVENT_TYPES.TOOL_FINISHED && id) patch.activeToolIds = runtime.activeToolIds.filter((item) => item !== id);
  const subagentId = valueField(evidence, 'subagentId', 'subagent_id', 'id');
  if (evidence.signalType === EVENT_TYPES.SUBAGENT_STARTED && subagentId) patch.activeSubagentIds = [...runtime.activeSubagentIds, subagentId];
  if (evidence.signalType === EVENT_TYPES.SUBAGENT_FINISHED && subagentId) patch.activeSubagentIds = runtime.activeSubagentIds.filter((item) => item !== subagentId);
}

function reduceEvidence(runtime, input) {
  const evidence = normalizeEvidence(input);
  if (!runtime || typeof runtime !== 'object') throw new TypeError('runtime is required');
  if (runtime.recentEvidence.some((item) => item.evidenceId === evidence.evidenceId)) return runtime;

  const patch = {
    recentEvidence: [...runtime.recentEvidence, evidence],
    lastEvidenceAt: Math.max(runtime.lastEvidenceAt || 0, evidence.observedAt),
    updatedAt: Math.max(runtime.updatedAt || 0, evidence.observedAt),
  };
  if (evidence.authority >= 90) patch.lastStrongEvidenceAt = Math.max(runtime.lastStrongEvidenceAt || 0, evidence.observedAt);
  if (isChildEvidence(evidence)) return cloneRuntime(runtime, patch);

  const dimensions = dimensionsForSignal(evidence.signalType);
  for (const dimension of dimensions) {
    if (!isWinning(runtime, evidence, dimension)) continue;
    patch.winningEvidence = { ...runtime.winningEvidence, [dimension]: evidence.evidenceId };
    patch.confidence = { ...runtime.confidence, [dimension]: evidence.confidence };
    if (dimension === CANONICAL_DIMENSIONS.LIVENESS) applyLiveness(runtime, evidence, patch);
    if (dimension === CANONICAL_DIMENSIONS.SESSION_LIFECYCLE) applyLifecycle(runtime, evidence, patch);
    if (dimension === CANONICAL_DIMENSIONS.TURN) applyTurn(runtime, evidence, patch);
    if (dimension === CANONICAL_DIMENSIONS.ACTIVITY) applyActivity(runtime, evidence, patch);
    if (dimension === CANONICAL_DIMENSIONS.ATTENTION) applyAttention(runtime, evidence, patch);
  }
  applyCollection(runtime, evidence, patch);
  if (dimensions.some((dimension) => dimension !== CANONICAL_DIMENSIONS.LIVENESS)) openSession(runtime, patch);
  if (ACTIVITY_SIGNALS.has(evidence.signalType)) patch.lastActivityAt = Math.max(runtime.lastActivityAt || 0, evidence.observedAt);
  return cloneRuntime(runtime, patch);
}

module.exports = { dimensionsForSignal, reduceEvidence };
