'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { ATTENTION_STATES, ACTIVITY_STATES, SESSION_LIFECYCLE_STATES, TURN_STATES } = require('./enums');
const { cloneRuntime, createInitialRuntime } = require('./runtime');
const { createCompletionId, markCompletionNotified, markTurnSeen, markTurnDone } = require('./completion');

function runtime(patch = {}) {
  return cloneRuntime(createInitialRuntime({ sessionRef: 'codex:completion-session' }), {
    sessionLifecycle: SESSION_LIFECYCLE_STATES.OPEN,
    turnState: TURN_STATES.COMPLETED,
    activityState: ACTIVITY_STATES.IDLE,
    attentionState: ATTENTION_STATES.COMPLETED_UNSEEN,
    ...patch,
  });
}

test('completion ID is deterministic and changes for a different turn or timestamp', () => {
  const input = { agent: 'codex', runtimeSessionKey: 'codex:native:gen:2', turnId: 'turn-1', completedAt: 200 };
  assert.equal(createCompletionId(input), 'codex:codex:native:gen:2:turn-1:200');
  assert.notEqual(createCompletionId(input), createCompletionId({ ...input, turnId: 'turn-2' }));
  assert.notEqual(createCompletionId(input), createCompletionId({ ...input, completedAt: 201 }));
});

test('completion notification is emitted once per runtime completion ID', () => {
  const first = markCompletionNotified(runtime(), 'completion-1');
  const duplicate = markCompletionNotified(first.runtime, 'completion-1');
  const second = markCompletionNotified(duplicate.runtime, 'completion-2');

  assert.equal(first.notified, true);
  assert.equal(duplicate.notified, false);
  assert.equal(second.notified, true);
  assert.deepEqual(second.runtime.completionNotificationIds, ['completion-1', 'completion-2']);
});

test('mark seen and mark turn done do not close the Session', () => {
  const seen = markTurnSeen(runtime());
  const done = markTurnDone(cloneRuntime(runtime(), { turnState: TURN_STATES.RUNNING, attentionState: ATTENTION_STATES.NONE }), 'turn-1');

  assert.equal(seen.attentionState, ATTENTION_STATES.NONE);
  assert.equal(done.turnState, TURN_STATES.COMPLETED);
  assert.equal(done.activityState, ACTIVITY_STATES.IDLE);
  assert.equal(done.sessionLifecycle, SESSION_LIFECYCLE_STATES.OPEN);
});
