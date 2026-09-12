'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { EVENT_TYPES } = require('./events');
const { initialState, applyEvent } = require('./reducer');

function event(type, timestamp, extra = {}) {
  return {
    schemaVersion: 1,
    eventId: `${type}:${timestamp}:${extra.turnId || ''}`,
    agent: 'codex',
    sessionId: 'session-1',
    sessionRef: 'codex:session-1',
    timestamp,
    type,
    source: 'test',
    ...extra,
  };
}

test('completion candidate confirms only after stabilization and live activity vetoes it', () => {
  let state = initialState();
  state = applyEvent(state, event(EVENT_TYPES.TURN_STARTED, 100, { turnId: 'turn-1' }));
  state = applyEvent(state, event(EVENT_TYPES.TURN_COMPLETED_SIGNAL, 200, { turnId: 'turn-1' }));
  assert.equal(state.publicState, 'COMPLETION_CANDIDATE');
  assert.equal(state.completionCandidateAt, 200);

  const vetoed = applyEvent(state, event(EVENT_TYPES.USER_MESSAGE, 250, { turnId: 'turn-2' }));
  assert.equal(vetoed.publicState, 'ACTIVE');
  assert.equal(vetoed.turnId, 'turn-2');
});

test('terminal states ignore stale events but newer real activity opens a new turn', () => {
  let state = initialState();
  state = applyEvent(state, event(EVENT_TYPES.TURN_STARTED, 100, { turnId: 'turn-1' }));
  state = applyEvent(state, event(EVENT_TYPES.TURN_FAILED, 200, { turnId: 'turn-1' }));
  assert.equal(state.publicState, 'FAILED');

  const stale = applyEvent(state, event(EVENT_TYPES.HEARTBEAT, 150, { turnId: 'turn-1' }));
  assert.equal(stale.publicState, 'FAILED');
  const resumed = applyEvent(stale, event(EVENT_TYPES.USER_MESSAGE, 300, { turnId: 'turn-2' }));
  assert.equal(resumed.publicState, 'ACTIVE');
  assert.equal(resumed.terminalAt, 0);
  assert.equal(resumed.turnId, 'turn-2');
});

test('duplicate and child events are idempotent and do not alter the parent state', () => {
  const started = event(EVENT_TYPES.TURN_STARTED, 100, { turnId: 'turn-1' });
  let state = applyEvent(initialState(), started);
  const duplicate = applyEvent(state, started);
  assert.deepEqual(duplicate, state);

  const child = event(EVENT_TYPES.SUBAGENT_FINISHED, 200, {
    eventId: 'child-finished',
    topology: { role: 'child', parentSessionRef: 'codex:session-1' },
  });
  const afterChild = applyEvent(state, child);
  assert.deepEqual(afterChild, state);
});
