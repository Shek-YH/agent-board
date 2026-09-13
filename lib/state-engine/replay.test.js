'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { EVENT_TYPES, SESSION_LIFECYCLE_STATES, TURN_STATES } = require('./enums');
const { replay } = require('./replay');

function evidence(signalType, timestamp, value = {}, overrides = {}) {
  return {
    evidenceId: `${signalType}:${timestamp}`,
    agent: 'codex',
    sessionRef: 'codex:session-1',
    source: 'jsonl',
    signalType,
    value,
    occurredAt: timestamp,
    observedAt: timestamp,
    confidence: 0.99,
    authority: 90,
    ...overrides,
  };
}

test('replay returns a deterministic runtime and diagnostic trace without mutating input', () => {
  const input = [
    evidence(EVENT_TYPES.TURN_STARTED, 100, { turnId: 'turn-1' }),
    evidence(EVENT_TYPES.TURN_COMPLETION_SIGNAL, 200, { turnId: 'turn-1' }),
    evidence(EVENT_TYPES.TURN_COMPLETED, 210, { turnId: 'turn-1' }),
  ];
  const before = JSON.parse(JSON.stringify(input));
  const first = replay(input);
  const second = replay(input);

  assert.deepEqual(input, before);
  assert.deepEqual(first, second);
  assert.equal(first.runtime.turnState, TURN_STATES.COMPLETED);
  assert.equal(first.runtime.sessionLifecycle, SESSION_LIFECYCLE_STATES.OPEN);
  assert.deepEqual(first.trace.map((item) => item.evidenceId), input.map((item) => item.evidenceId));
  assert.ok(first.trace.every((item) => item.canonical && typeof item.changed === 'boolean'));
});

test('replay rejects evidence from another session instead of mixing state', () => {
  assert.throws(() => replay([
    evidence(EVENT_TYPES.TURN_STARTED, 100),
    evidence(EVENT_TYPES.TURN_STARTED, 110, { turnId: 'other' }, { evidenceId: 'other', sessionRef: 'codex:session-2' }),
  ]), /sessionRef/);
});

test('replay accepts an explicit initial runtime for deterministic recovery', () => {
  const result = replay([evidence(EVENT_TYPES.SESSION_CLOSED, 300)], {
    sessionRef: 'codex:session-1',
  });
  assert.equal(result.runtime.sessionLifecycle, SESSION_LIFECYCLE_STATES.CLOSED);
});
