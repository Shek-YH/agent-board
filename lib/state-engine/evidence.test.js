'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  CANONICAL_DIMENSIONS,
  EVIDENCE_SOURCES,
  EVENT_TYPES,
  SOURCE_HEALTH_STATES,
} = require('./enums');
const { normalizeEvidence } = require('./evidence');

function validEvidence(overrides = {}) {
  return {
    evidenceId: 'ev-1',
    agent: 'codex',
    sessionRef: 'codex:session-1',
    source: 'jsonl',
    signalType: 'TURN_COMPLETED',
    value: { turnId: 'turn-1' },
    occurredAt: 100,
    observedAt: 110,
    confidence: 0.99,
    authority: 90,
    ...overrides,
  };
}

test('canonical dimensions, evidence sources, event types, and health states are immutable', () => {
  assert.deepEqual(Object.keys(CANONICAL_DIMENSIONS), [
    'LIVENESS', 'SESSION_LIFECYCLE', 'TURN', 'ACTIVITY', 'ATTENTION',
  ]);
  assert.ok(Object.isFrozen(CANONICAL_DIMENSIONS));
  assert.ok(Object.isFrozen(EVIDENCE_SOURCES));
  assert.ok(Object.isFrozen(EVENT_TYPES));
  assert.ok(Object.isFrozen(SOURCE_HEALTH_STATES));
  assert.equal(CANONICAL_DIMENSIONS.TURN, 'turnState');
  assert.equal(EVIDENCE_SOURCES.JSONL, 'jsonl');
  assert.equal(EVENT_TYPES.TURN_COMPLETED, 'TURN_COMPLETED');
  assert.equal(SOURCE_HEALTH_STATES.DEGRADED, 'DEGRADED');
});

test('normalizeEvidence preserves both clocks and bounds numeric scores', () => {
  const result = normalizeEvidence(validEvidence({ confidence: 2, authority: -5 }));

  assert.equal(result.occurredAt, 100);
  assert.equal(result.observedAt, 110);
  assert.equal(result.confidence, 1);
  assert.equal(result.authority, 0);
  assert.equal(result.value.turnId, 'turn-1');
  assert.ok(Object.isFrozen(result));
});

test('normalizeEvidence rejects missing identity, invalid clocks, and unknown sources', () => {
  assert.throws(() => normalizeEvidence(validEvidence({ sessionRef: '' })), /sessionRef/);
  assert.throws(() => normalizeEvidence(validEvidence({ occurredAt: 'later' })), /occurredAt/);
  assert.throws(() => normalizeEvidence(validEvidence({ observedAt: -1 })), /observedAt/);
  assert.throws(() => normalizeEvidence(validEvidence({ source: 'screen_guess' })), /source/);
});

test('normalizeEvidence rejects secret and transcript body fields', () => {
  for (const field of ['apiKey', 'token', 'cookie', 'password', 'secret', 'body', 'prompt', 'response']) {
    assert.throws(
      () => normalizeEvidence(validEvidence({ [field]: 'private-data' })),
      new RegExp(field, 'i'),
    );
  }
  assert.throws(
    () => normalizeEvidence(validEvidence({ evidence: { messageBody: 'private-data' } })),
    /messageBody/,
  );
});
