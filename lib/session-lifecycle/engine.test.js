'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createSessionLifecycleEngine } = require('./engine');
const { createRuntimeStore } = require('./runtime-store');

const base = (type, timestamp, eventId = `${type}:${timestamp}`) => ({
  schemaVersion: 1,
  eventId,
  agent: 'workbuddy',
  sessionRef: 'workbuddy:session-1',
  sessionId: 'session-1',
  timestamp,
  type,
  source: 'test',
});

test('engine confirms a stable completion candidate and remains idempotent on replay', () => {
  let now = 0;
  const engine = createSessionLifecycleEngine({ stabilizationMs: 100, clock: () => now });
  engine.ingest(base('TURN_STARTED', 10, 'start'));
  engine.ingest(base('TURN_COMPLETED_SIGNAL', 20, 'complete'));
  assert.equal(engine.getState().publicState, 'COMPLETION_CANDIDATE');
  assert.equal(engine.advance(119).changed, false);
  now = 120;
  assert.equal(engine.advance().state.publicState, 'COMPLETED');
  const replay = engine.ingest(base('TURN_COMPLETED_SIGNAL', 20, 'complete'));
  assert.equal(replay.changed, false);
  assert.equal(engine.getState().publicState, 'COMPLETED');
});

test('runtime store isolates sessions and exposes only public snapshots', () => {
  const store = createRuntimeStore({ stabilizationMs: 0 });
  store.ingest('codex:a', { ...base('TURN_FAILED', 10, 'a-fail'), sessionRef: 'codex:a' });
  store.ingest('codex:b', { ...base('TURN_STARTED', 20, 'b-start'), sessionRef: 'codex:b' });
  assert.equal(store.snapshot('codex:a').publicState, 'FAILED');
  assert.equal(store.snapshot('codex:b').publicState, 'ACTIVE');
  assert.equal(store.snapshot('codex:a').seenEventIds, undefined);
});
