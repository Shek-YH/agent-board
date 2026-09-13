'use strict';

const IDENTITY_FIELDS = [
  'agent', 'hostId', 'nativeSessionId', 'processId', 'processStartedAt',
  'terminalInstanceId', 'terminalTTY', 'workspaceId', 'cwd', 'transcriptPath',
  'transcriptFileId', 'sessionRef', 'generation', 'generationReason',
];

/**
 * @typedef {Object} SessionIdentity
 * @property {string} agent
 * @property {string} hostId
 * @property {string} [nativeSessionId]
 * @property {number} [processId]
 * @property {number} [processStartedAt]
 * @property {string} [terminalInstanceId]
 * @property {string} [terminalTTY]
 * @property {string} [workspaceId]
 * @property {string} [cwd]
 * @property {string} [transcriptPath]
 * @property {string} [transcriptFileId]
 * @property {string} [sessionRef]
 * @property {number} generation
 * @property {string} [generationReason]
 */

function requiredString(value, field) {
  const result = String(value || '').trim();
  if (!result) throw new TypeError(`identity.${field} is required`);
  return result;
}

function optionalString(value) {
  if (value === undefined || value === null) return undefined;
  const result = String(value).trim();
  return result || undefined;
}

function nonNegativeInteger(value, field) {
  const result = Number(value ?? 0);
  if (!Number.isInteger(result) || result < 0) throw new TypeError(`identity.${field} must be a non-negative integer`);
  return result;
}

function nonNegativeNumber(value, field) {
  const result = Number(value);
  if (!Number.isFinite(result) || result < 0) throw new TypeError(`identity.${field} must be a non-negative number`);
  return result;
}

/** @returns {Readonly<SessionIdentity>} */
function createSessionIdentity(input = {}) {
  const identity = {
    agent: requiredString(input.agent, 'agent'),
    hostId: requiredString(input.hostId, 'hostId'),
    generation: nonNegativeInteger(input.generation, 'generation'),
  };
  for (const field of IDENTITY_FIELDS.slice(2, -2)) {
    if (input[field] === undefined || input[field] === null) continue;
    const value = ['processId'].includes(field)
      ? nonNegativeInteger(input[field], field)
      : ['processStartedAt'].includes(field)
        ? nonNegativeNumber(input[field], field)
        : optionalString(input[field]);
    if (value !== undefined) identity[field] = value;
  }
  const reason = optionalString(input.generationReason);
  if (reason) identity.generationReason = reason;
  return Object.freeze(identity);
}

/** @param {SessionIdentity} identity */
function runtimeSessionKey(identity) {
  const value = identity && typeof identity === 'object' ? identity : {};
  const agent = requiredString(value.agent, 'agent');
  const anchor = optionalString(value.nativeSessionId)
    || optionalString(value.transcriptFileId)
    || optionalString(value.sessionRef)
    || [agent, optionalString(value.hostId) || 'unknown', optionalString(value.terminalInstanceId) || 'unknown'].join(':');
  return `${agent}:${anchor}:gen:${nonNegativeInteger(value.generation, 'generation')}`;
}

function advanceGeneration(identity, reason) {
  const current = createSessionIdentity(identity);
  const nextReason = requiredString(reason, 'generationReason');
  return createSessionIdentity({ ...current, generation: current.generation + 1, generationReason: nextReason });
}

function sameSessionIdentity(left, right) {
  if (!left || !right || left.agent !== right.agent || left.hostId !== right.hostId) return false;
  if (left.nativeSessionId && right.nativeSessionId) return left.nativeSessionId === right.nativeSessionId;
  if (left.transcriptFileId && right.transcriptFileId) return left.transcriptFileId === right.transcriptFileId;
  if (left.processId !== undefined && right.processId !== undefined && left.processStartedAt !== undefined && right.processStartedAt !== undefined) {
    return left.processId === right.processId && left.processStartedAt === right.processStartedAt;
  }
  if (left.terminalInstanceId && right.terminalInstanceId) return left.terminalInstanceId === right.terminalInstanceId;
  if (left.sessionRef && right.sessionRef) return left.sessionRef === right.sessionRef;
  return false;
}

module.exports = { createSessionIdentity, runtimeSessionKey, advanceGeneration, sameSessionIdentity };
