'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { ACTIVITY_STATES, SESSION_LIFECYCLE_STATES, TURN_STATES } = require('./enums');
const { createInitialRuntime, cloneRuntime } = require('./runtime');
const { compareLegacyState } = require('./comparison');

function runtime(patch = {}) {
  return cloneRuntime(createInitialRuntime({ sessionRef: 'codex:session-1' }), {
    sessionLifecycle: SESSION_LIFECYCLE_STATES.OPEN,
    ...patch,
  });
}

test('shadow comparison exposes canonical differences without session content', () => {
  const result = compareLegacyState('completed', runtime({ turnState: TURN_STATES.COMPLETED, activityState: ACTIVITY_STATES.IDLE }));

  assert.equal(result.legacy, 'completed');
  assert.equal(result.v2.turnState, TURN_STATES.COMPLETED);
  assert.equal(result.v2.sessionLifecycle, SESSION_LIFECYCLE_STATES.OPEN);
  assert.equal(result.divergence, true);
  assert.match(result.reasons[0], /session_open/);
  assert.equal(JSON.stringify(result).includes('session-1'), false);
});

test('matching non-terminal legacy and V2 states do not diverge', () => {
  const result = compareLegacyState('running', runtime({ turnState: TURN_STATES.RUNNING, activityState: ACTIVITY_STATES.THINKING }));
  assert.equal(result.divergence, false);
  assert.deepEqual(result.reasons, []);
});

test('comparison normalizes unknown legacy values and never copies arbitrary fields', () => {
  const result = compareLegacyState('private prompt body', runtime({ turnState: TURN_STATES.RUNNING }));
  assert.equal(result.legacy, 'unknown');
  assert.equal(Object.hasOwn(result, 'ignored'), false);
  assert.equal(JSON.stringify(result).includes('private'), false);
  assert.equal(JSON.stringify(result).includes('token'), false);
});
