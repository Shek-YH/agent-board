'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createRuntimeStore } = require('./runtime-store');
const { replayLifecycleSnapshot } = require('./replay');

test('replay restores explicit terminal evidence but does not invent active state from old messages', () => {
  const runtime = createRuntimeStore({ stabilizationMs: 0 });
  const result = replayLifecycleSnapshot(runtime, {
    sessions: [
      { id: 'codex:done', agent: 'codex', session_id: 'done', last_seen: 200 },
      { id: 'workbuddy:old', agent: 'workbuddy', session_id: 'old', last_seen: 300 },
    ],
    messages: [{ session_ref: 'workbuddy:old', agent: 'workbuddy', source_id: 'old-user', role: 'user', ts: 300 }],
    manualStatus: [{ ref: 'codex:done', status: 'done' }],
    doneSignalAt: [{ ref: 'workbuddy:old', ts: 250 }],
  });
  assert.equal(result.restored, 2);
  assert.equal(runtime.snapshot('codex:done').publicState, 'COMPLETED');
  assert.equal(runtime.snapshot('workbuddy:old').publicState, 'COMPLETED');
  assert.equal(runtime.entries().some(([ref]) => ref === 'workbuddy:old'), true);
});

test('replay is idempotent and ignores non-terminal historical messages', () => {
  const runtime = createRuntimeStore({ stabilizationMs: 0 });
  const snapshot = {
    sessions: [{ id: 'codex:active', agent: 'codex', session_id: 'active', last_seen: 500 }],
    messages: [{ session_ref: 'codex:active', agent: 'codex', source_id: 'old', role: 'user', ts: 500 }],
  };
  assert.equal(replayLifecycleSnapshot(runtime, snapshot).restored, 0);
  assert.equal(runtime.entries().length, 0);
  assert.equal(replayLifecycleSnapshot(runtime, snapshot).restored, 0);
});
