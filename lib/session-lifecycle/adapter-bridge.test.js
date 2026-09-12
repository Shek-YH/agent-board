'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createRuntimeStore } = require('./runtime-store');
const {
  applyStoreMessage,
  applyExternalStatus,
  applyHeartbeat,
  applyManualCompletion,
  applyWorkBuddyRuntimeStatus,
} = require('./adapter-bridge');

test('Codex and WorkBuddy adapter evidence becomes normalized lifecycle state', () => {
  const runtime = createRuntimeStore({ stabilizationMs: 0 });
  applyStoreMessage(runtime, {
    agent: 'codex', sessionId: 'c1', sourceId: 'turn-1', kind: 'turn_start', ts: 100, turnId: 't1',
  });
  applyStoreMessage(runtime, {
    agent: 'codex', sessionId: 'c1', sourceId: 'turn-1-done', kind: 'turn_end', ts: 200, turnId: 't1',
  });
  assert.equal(runtime.snapshot('codex:c1').publicState, 'COMPLETION_CANDIDATE');

  applyStoreMessage(runtime, {
    agent: 'workbuddy', sessionId: 'w1', sourceId: 'user-1', kind: 'message', role: 'user', ts: 300,
  });
  assert.equal(runtime.snapshot('workbuddy:w1').publicState, 'ACTIVE');
});

test('external terminal, heartbeat, and manual completion share idempotent event semantics', () => {
  const runtime = createRuntimeStore({ stabilizationMs: 0 });
  applyExternalStatus(runtime, 'workbuddy:w1', { statusAt: 100, terminal: true, status: 'completed' });
  applyExternalStatus(runtime, 'workbuddy:w1', { statusAt: 100, terminal: true, status: 'completed' });
  assert.equal(runtime.snapshot('workbuddy:w1').publicState, 'COMPLETED');
  applyHeartbeat(runtime, 'workbuddy:w1', true, 90);
  assert.equal(runtime.snapshot('workbuddy:w1').publicState, 'COMPLETED');
  applyManualCompletion(runtime, 'workbuddy:w1', 200);
  assert.equal(runtime.snapshot('workbuddy:w1').publicState, 'COMPLETED');
});

test('WorkBuddy runtime states map to public lifecycle states', () => {
  const runtime = createRuntimeStore({ stabilizationMs: 0 });
  applyWorkBuddyRuntimeStatus(runtime, 'workbuddy:w1', { state: 'waiting_user', lastEventAt: 100 });
  assert.equal(runtime.snapshot('workbuddy:w1').publicState, 'WAITING_USER');
  applyWorkBuddyRuntimeStatus(runtime, 'workbuddy:w1', { state: 'completed', lastEventAt: 200 });
  assert.equal(runtime.snapshot('workbuddy:w1').publicState, 'COMPLETED');
});
