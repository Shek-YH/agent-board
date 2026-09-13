'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { ACTIVITY_STATES, LIVENESS_STATES, SESSION_LIFECYCLE_STATES, TURN_STATES, ATTENTION_STATES } = require('./enums');
const { DEFAULT_RECENT_EVIDENCE_LIMIT, createInitialRuntime, cloneRuntime } = require('./runtime');

test('createInitialRuntime creates all canonical dimensions and a generation-scoped key', () => {
  const runtime = createInitialRuntime({
    sessionRef: 'codex:session-1',
    identity: { agent: 'codex', hostId: 'host-1', nativeSessionId: 'native-session-1', generation: 4 },
    updatedAt: 120,
  });

  assert.equal(runtime.sessionRef, 'codex:session-1');
  assert.equal(runtime.runtimeSessionKey, 'codex:native-session-1:gen:4');
  assert.deepEqual(runtime.identity, {
    agent: 'codex', hostId: 'host-1', nativeSessionId: 'native-session-1', generation: 4,
  });
  assert.equal(runtime.liveness, LIVENESS_STATES.UNKNOWN);
  assert.equal(runtime.sessionLifecycle, SESSION_LIFECYCLE_STATES.UNKNOWN);
  assert.equal(runtime.turnState, TURN_STATES.NONE);
  assert.equal(runtime.activityState, ACTIVITY_STATES.UNKNOWN);
  assert.equal(runtime.attentionState, ATTENTION_STATES.NONE);
  assert.deepEqual(runtime.activeToolIds, []);
  assert.deepEqual(runtime.activeSubagentIds, []);
  assert.deepEqual(runtime.winningEvidence, {});
  assert.deepEqual(runtime.confidence, {});
  assert.deepEqual(runtime.recentEvidence, []);
  assert.equal(runtime.updatedAt, 120);
  assert.ok(Object.isFrozen(runtime));
  assert.ok(Object.isFrozen(runtime.identity));
});

test('createInitialRuntime derives safe defaults and rejects invalid session identity', () => {
  const runtime = createInitialRuntime({ sessionRef: 'workbuddy:session-2' });
  assert.deepEqual(runtime.identity, { agent: 'workbuddy', hostId: 'local', generation: 0 });
  assert.equal(runtime.runtimeSessionKey, 'workbuddy:session-2:gen:0');
  assert.throws(() => createInitialRuntime({ sessionRef: '' }), /sessionRef/);
  assert.throws(() => createInitialRuntime({ sessionRef: 'codex:x', identity: { generation: -1 } }), /generation/);
});

test('cloneRuntime applies bounded runtime patches without mutating the original', () => {
  const original = createInitialRuntime({ sessionRef: 'codex:session-3' });
  const recentEvidence = Array.from({ length: DEFAULT_RECENT_EVIDENCE_LIMIT + 2 }, (_, index) => ({ evidenceId: `ev-${index}` }));
  const next = cloneRuntime(original, {
    liveness: LIVENESS_STATES.ALIVE,
    activityState: ACTIVITY_STATES.THINKING,
    activeToolIds: ['tool-1', 'tool-1', 'tool-2'],
    activeSubagentIds: ['child-1'],
    recentEvidence,
    updatedAt: 200,
  });

  assert.equal(original.liveness, LIVENESS_STATES.UNKNOWN);
  assert.deepEqual(original.activeToolIds, []);
  assert.equal(next.liveness, LIVENESS_STATES.ALIVE);
  assert.equal(next.activityState, ACTIVITY_STATES.THINKING);
  assert.deepEqual(next.activeToolIds, ['tool-1', 'tool-2']);
  assert.deepEqual(next.activeSubagentIds, ['child-1']);
  assert.equal(next.recentEvidence.length, DEFAULT_RECENT_EVIDENCE_LIMIT);
  assert.equal(next.recentEvidence[0].evidenceId, 'ev-2');
  assert.equal(next.recentEvidence.at(-1).evidenceId, `ev-${DEFAULT_RECENT_EVIDENCE_LIMIT + 1}`);
  assert.equal(next.updatedAt, 200);
  assert.ok(Object.isFrozen(next));
  assert.ok(Object.isFrozen(next.activeToolIds));
});
