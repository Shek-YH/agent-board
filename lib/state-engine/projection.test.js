'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { ACTIVITY_STATES, ATTENTION_STATES, LIVENESS_STATES, SESSION_LIFECYCLE_STATES, TURN_STATES } = require('./enums');
const { createInitialRuntime, cloneRuntime } = require('./runtime');
const { projectLegacyState, projectUiStatus, projectStatus, resolveStateEngineMode } = require('./projection');

function runtime(patch = {}) {
  return cloneRuntime(createInitialRuntime({ sessionRef: 'codex:session-1' }), {
    sessionLifecycle: SESSION_LIFECYCLE_STATES.OPEN,
    ...patch,
  });
}

test('UI projection uses activity and turn semantics without exposing internal liveness/session values', () => {
  const status = projectUiStatus(runtime({
    liveness: LIVENESS_STATES.ALIVE,
    turnState: TURN_STATES.RUNNING,
    activityState: ACTIVITY_STATES.WAITING_APPROVAL,
    attentionState: ATTENTION_STATES.ACTION_REQUIRED,
  }));

  assert.equal(status.key, 'waiting_approval');
  assert.equal(status.label, '等待批准');
  assert.equal(status.kind, 'waiting');
  assert.equal(status.attentionRequired, true);
  assert.notEqual(status.label, 'ALIVE');
  assert.notEqual(status.label, 'OPEN');
});

test('completed turn projects as completed while an open session remains visible in canonical data', () => {
  const state = runtime({
    liveness: LIVENESS_STATES.ALIVE,
    turnState: TURN_STATES.COMPLETED,
    activityState: ACTIVITY_STATES.IDLE,
    attentionState: ATTENTION_STATES.COMPLETED_UNSEEN,
  });
  const status = projectUiStatus(state);

  assert.equal(status.key, 'completed');
  assert.equal(status.label, '本轮已完成');
  assert.equal(status.canonical.sessionLifecycle, SESSION_LIFECYCLE_STATES.OPEN);
  assert.equal(projectLegacyState(state), 'completed');
});

test('failed and interrupted turn projections stay distinct', () => {
  assert.equal(projectUiStatus(runtime({ turnState: TURN_STATES.FAILED })).key, 'failed');
  assert.equal(projectUiStatus(runtime({ turnState: TURN_STATES.INTERRUPTED })).key, 'interrupted');
  assert.equal(projectLegacyState(runtime({ turnState: TURN_STATES.INTERRUPTED })), 'interrupted');
});

test('feature flag resolves off by default and separates legacy primary from shadow V2', () => {
  const completedOpen = runtime({ turnState: TURN_STATES.COMPLETED, activityState: ACTIVITY_STATES.IDLE });
  assert.equal(resolveStateEngineMode(), 'off');
  assert.equal(resolveStateEngineMode('invalid'), 'off');
  assert.equal(resolveStateEngineMode('SHADOW'), 'shadow');
  assert.equal(projectStatus(completedOpen, 'off').source, 'legacy');
  assert.equal(projectStatus(completedOpen, 'shadow').source, 'legacy');
  assert.equal(projectStatus(completedOpen, 'shadow').v2.key, 'completed');
  assert.equal(projectStatus(completedOpen, 'shadow').divergence, true);
  assert.equal(projectStatus(completedOpen, 'on').source, 'state-engine-v2');
});
