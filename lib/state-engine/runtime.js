'use strict';

const {
  ACTIVITY_STATES,
  ATTENTION_STATES,
  LIVENESS_STATES,
  SESSION_LIFECYCLE_STATES,
  TURN_STATES,
} = require('./enums');

const DEFAULT_RECENT_EVIDENCE_LIMIT = 1000;
const IDENTITY_FIELDS = [
  'agent', 'hostId', 'nativeSessionId', 'processId', 'processStartedAt',
  'terminalInstanceId', 'terminalTTY', 'workspaceId', 'cwd',
  'transcriptPath', 'transcriptFileId', 'generation',
];

function assertSessionRef(sessionRef) {
  const value = String(sessionRef || '').trim();
  if (!value) throw new TypeError('sessionRef is required');
  return value;
}

function nonNegativeInteger(value, field) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new TypeError(`${field} must be a non-negative integer`);
  return number;
}

function timestamp(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new TypeError(`${field} must be a non-negative finite number`);
  return number;
}

function normalizeIdentity(sessionRef, input = {}) {
  const agent = String(input.agent || sessionRef.split(':', 1)[0] || 'unknown').trim();
  const hostId = String(input.hostId || 'local').trim();
  if (!agent) throw new TypeError('identity.agent is required');
  if (!hostId) throw new TypeError('identity.hostId is required');
  const identity = { agent, hostId };
  for (const field of IDENTITY_FIELDS.slice(2, -1)) {
    if (input[field] !== undefined && input[field] !== null) identity[field] = input[field];
  }
  identity.generation = nonNegativeInteger(input.generation ?? 0, 'identity.generation');
  return identity;
}

function uniqueIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))];
}

function copyRecord(value, transform) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [String(key), transform(item)]));
}

function cloneValue(value, seen = new Map()) {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);
  if (Array.isArray(value)) {
    const result = [];
    seen.set(value, result);
    for (const item of value) result.push(cloneValue(item, seen));
    return result;
  }
  const result = {};
  seen.set(value, result);
  for (const [key, item] of Object.entries(value)) result[key] = cloneValue(item, seen);
  return result;
}

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const item of Object.values(value)) deepFreeze(item, seen);
  return Object.freeze(value);
}

function normalizeRuntime(input) {
  const sessionRef = assertSessionRef(input.sessionRef);
  const identity = normalizeIdentity(sessionRef, input.identity);
  const runtimeSessionKey = String(
    input.runtimeSessionKey || `${sessionRef}:gen:${identity.generation}`,
  ).trim();
  if (!runtimeSessionKey) throw new TypeError('runtimeSessionKey is required');
  const recentEvidence = Array.isArray(input.recentEvidence)
    ? input.recentEvidence.slice(-DEFAULT_RECENT_EVIDENCE_LIMIT).map((item) => cloneValue(item))
    : [];
  const result = {
    sessionRef,
    runtimeSessionKey,
    identity,
    liveness: input.liveness || LIVENESS_STATES.UNKNOWN,
    sessionLifecycle: input.sessionLifecycle || SESSION_LIFECYCLE_STATES.UNKNOWN,
    turnState: input.turnState || TURN_STATES.NONE,
    activityState: input.activityState || ACTIVITY_STATES.UNKNOWN,
    attentionState: input.attentionState || ATTENTION_STATES.NONE,
    currentTurnId: input.currentTurnId ?? null,
    lastActivityAt: input.lastActivityAt ?? null,
    lastEvidenceAt: input.lastEvidenceAt ?? null,
    lastStrongEvidenceAt: input.lastStrongEvidenceAt ?? null,
    activeToolIds: uniqueIds(input.activeToolIds),
    activeSubagentIds: uniqueIds(input.activeSubagentIds),
    winningEvidence: copyRecord(input.winningEvidence, (item) => String(item)),
    confidence: copyRecord(input.confidence, (item) => {
      const number = Number(item);
      return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : 0;
    }),
    recentEvidence,
    updatedAt: timestamp(input.updatedAt ?? 0, 'updatedAt'),
  };
  return deepFreeze(result);
}

function createInitialRuntime(options = {}) {
  return normalizeRuntime(options);
}

function cloneRuntime(runtime, patch = {}) {
  if (!runtime || typeof runtime !== 'object') throw new TypeError('runtime must be an object');
  const input = { ...cloneValue(runtime), ...cloneValue(patch) };
  if (patch.identity) input.identity = { ...cloneValue(runtime.identity), ...cloneValue(patch.identity) };
  if (patch.identity && patch.runtimeSessionKey === undefined) {
    input.runtimeSessionKey = `${input.sessionRef}:gen:${input.identity.generation}`;
  }
  return normalizeRuntime(input);
}

module.exports = {
  DEFAULT_RECENT_EVIDENCE_LIMIT,
  createInitialRuntime,
  cloneRuntime,
};
