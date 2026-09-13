'use strict';

const { EVIDENCE_SOURCES } = require('./enums');

const SOURCE_VALUES = new Set(Object.values(EVIDENCE_SOURCES));
const SAFE_FIELDS = new Set([
  'evidenceId', 'agent', 'sessionRef', 'source', 'signalType', 'value',
  'occurredAt', 'observedAt', 'sourceSequence', 'sourceGeneration',
  'confidence', 'authority', 'expiresAt', 'nativeSessionId', 'processId',
  'processStartedAt', 'transcriptPath', 'terminalId', 'evidence',
]);
const FORBIDDEN_KEY = /(?:api[_-]?key|access[_-]?token|token|cookie|password|secret|credential|prompt|response|message|body|content)/i;

/**
 * @typedef {Object} NormalizedEvidence
 * @property {string} evidenceId
 * @property {string} agent
 * @property {string} sessionRef
 * @property {string} source
 * @property {string} signalType
 * @property {*} [value]
 * @property {number} occurredAt
 * @property {number} observedAt
 * @property {number} confidence
 * @property {number} authority
 * @property {number} [sourceSequence]
 * @property {number} [sourceGeneration]
 * @property {number} [expiresAt]
 * @property {number} [processId]
 * @property {number} [processStartedAt]
 * @property {string} [nativeSessionId]
 * @property {string} [transcriptPath]
 * @property {string} [terminalId]
 * @property {Object} [evidence]
 */

function clamp(value, min, max, field) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError(`${field} must be finite`);
  return Math.min(max, Math.max(min, number));
}

function clockValue(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new TypeError(`${field} must be a non-negative finite number`);
  return number;
}

function assertSafeMetadata(value, path = 'value', seen = new Set()) {
  if (value === null || value === undefined || typeof value !== 'object') return;
  if (seen.has(value)) throw new TypeError(`${path} must not contain cycles`);
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafeMetadata(item, `${path}[${index}]`, seen));
  } else {
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_KEY.test(key)) throw new TypeError(`${path}.${key} is not allowed`);
      assertSafeMetadata(item, `${path}.${key}`, seen);
    }
  }
  seen.delete(value);
}

function optionalNumber(input, field, min = 0) {
  if (input === undefined || input === null) return undefined;
  return clamp(input, min, Number.MAX_SAFE_INTEGER, field);
}

/** @returns {Readonly<NormalizedEvidence>} */
function normalizeEvidence(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('evidence must be an object');
  }
  for (const key of Object.keys(input)) {
    if (!SAFE_FIELDS.has(key)) throw new TypeError(`evidence field ${key} is not allowed`);
  }
  const evidenceId = String(input.evidenceId || '').trim();
  const agent = String(input.agent || '').trim();
  const sessionRef = String(input.sessionRef || '').trim();
  const signalType = String(input.signalType || '').trim();
  if (!evidenceId) throw new TypeError('evidenceId is required');
  if (!agent) throw new TypeError('agent is required');
  if (!sessionRef) throw new TypeError('sessionRef is required');
  if (!signalType) throw new TypeError('signalType is required');
  if (!SOURCE_VALUES.has(input.source)) throw new TypeError('source is unsupported');

  const occurredAt = clockValue(input.occurredAt, 'occurredAt');
  const observedAt = clockValue(input.observedAt, 'observedAt');
  assertSafeMetadata(input.value, 'value');
  assertSafeMetadata(input.evidence, 'evidence');

  const result = {
    evidenceId,
    agent,
    sessionRef,
    source: input.source,
    signalType,
    value: input.value,
    occurredAt,
    observedAt,
    confidence: clamp(input.confidence ?? 0, 0, 1, 'confidence'),
    authority: clamp(input.authority ?? 0, 0, 100, 'authority'),
  };
  for (const field of [
    'sourceSequence', 'sourceGeneration', 'expiresAt', 'processId',
    'processStartedAt',
  ]) {
    const value = optionalNumber(input[field], field);
    if (value !== undefined) result[field] = value;
  }
  for (const field of ['nativeSessionId', 'transcriptPath', 'terminalId']) {
    if (input[field] !== undefined) result[field] = String(input[field]);
  }
  if (input.evidence !== undefined) result.evidence = input.evidence;
  return Object.freeze(result);
}

module.exports = { normalizeEvidence };
