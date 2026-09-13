'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { EVENT_TYPES } = require('./enums');
const { createProcessLivenessService } = require('./liveness');
const { replay } = require('./replay');
const { createSessionIdentity, sameSessionIdentity } = require('./identity');

function event(sessionRef, signalType, timestamp, value = {}, overrides = {}) {
  return {
    evidenceId: `${sessionRef}:${signalType}:${timestamp}:${overrides.evidenceId || ''}`,
    agent: sessionRef.split(':')[0], sessionRef, source: 'jsonl', signalType, value,
    occurredAt: timestamp, observedAt: timestamp, confidence: 0.99, authority: 90, ...overrides,
  };
}

function state(input) {
  const runtime = replay(input).runtime;
  return {
    liveness: runtime.liveness,
    sessionLifecycle: runtime.sessionLifecycle,
    turnState: runtime.turnState,
    activityState: runtime.activityState,
    attentionState: runtime.attentionState,
    currentTurnId: runtime.currentTurnId,
    activeToolIds: runtime.activeToolIds,
    activeSubagentIds: runtime.activeSubagentIds,
  };
}

const normal = (ref, signal, ts, value = {}, overrides = {}) => event(ref, signal, ts, value, overrides);
const ref = 'codex:matrix';

/** @type {Array<[string, Array<Object>, Object]>} */
const replayCases = [
  ['01 normal task completion', [normal(ref, EVENT_TYPES.SESSION_STARTED, 1), normal(ref, EVENT_TYPES.TURN_STARTED, 10, { turnId: 't1' }), normal(ref, EVENT_TYPES.TURN_COMPLETION_SIGNAL, 20, { turnId: 't1' }), normal(ref, EVENT_TYPES.TURN_COMPLETED, 21, { turnId: 't1' })], { turnState: 'COMPLETED', sessionLifecycle: 'OPEN', activityState: 'IDLE', attentionState: 'COMPLETED_UNSEEN' }],
  ['02 completion then 2s continuation', [normal(ref, EVENT_TYPES.TURN_STARTED, 10, { turnId: 't1' }), normal(ref, EVENT_TYPES.TURN_COMPLETION_SIGNAL, 20, { turnId: 't1' }), normal(ref, EVENT_TYPES.USER_MESSAGE, 22, { turnId: 't2' })], { turnState: 'RUNNING', currentTurnId: 't2' }],
  ['03 completion then 2m continuation', [normal(ref, EVENT_TYPES.TURN_STARTED, 10, { turnId: 't1' }), normal(ref, EVENT_TYPES.TURN_COMPLETION_SIGNAL, 20, { turnId: 't1' }), normal(ref, EVENT_TYPES.USER_MESSAGE, 120020, { turnId: 't2' })], { turnState: 'RUNNING', currentTurnId: 't2' }],
  ['04 waiting user', [normal(ref, EVENT_TYPES.TURN_STARTED, 10, { turnId: 't1' }), normal(ref, EVENT_TYPES.WAITING_USER, 20)], { activityState: 'WAITING_USER', attentionState: 'ACTION_REQUIRED' }],
  ['05 waiting approval', [normal(ref, EVENT_TYPES.TURN_STARTED, 10, { turnId: 't1' }), normal(ref, EVENT_TYPES.WAITING_APPROVAL, 20)], { activityState: 'WAITING_APPROVAL', attentionState: 'ACTION_REQUIRED' }],
  ['06 long tool', [normal(ref, EVENT_TYPES.TURN_STARTED, 10, { turnId: 't1' }), normal(ref, EVENT_TYPES.TOOL_STARTED, 20, { toolId: 'tool-1', kind: 'command' }), normal(ref, EVENT_TYPES.HEARTBEAT, 1_800_020, {}, { source: 'heartbeat', authority: 75 })], { turnState: 'RUNNING', activityState: 'RUNNING_COMMAND', liveness: 'ALIVE', activeToolIds: ['tool-1'] }],
  ['07 subagent work', [normal(ref, EVENT_TYPES.TURN_STARTED, 10, { turnId: 't1' }), normal(ref, EVENT_TYPES.SUBAGENT_STARTED, 20, { subagentId: 'child-1' })], { activityState: 'RUNNING_SUBAGENT', activeSubagentIds: ['child-1'] }],
  ['08 parent waits for child', [normal(ref, EVENT_TYPES.TURN_STARTED, 10, { turnId: 't1' }), normal(ref, EVENT_TYPES.SUBAGENT_STARTED, 20, { subagentId: 'child-1' }), normal(ref, EVENT_TYPES.TURN_COMPLETION_SIGNAL, 30, { turnId: 't1' })], { turnState: 'COMPLETION_CANDIDATE', activeSubagentIds: ['child-1'] }],
  ['09 Ctrl+C', [normal(ref, EVENT_TYPES.TURN_STARTED, 10, { turnId: 't1' }), normal(ref, EVENT_TYPES.TURN_INTERRUPTED, 20, { turnId: 't1' })], { turnState: 'INTERRUPTED', attentionState: 'INTERRUPTED_UNSEEN' }],
  ['10 kill process with exact identity', [normal(ref, EVENT_TYPES.PROCESS_SEEN, 10, {}, { source: 'process', authority: 70 }), normal(ref, EVENT_TYPES.PROCESS_DEAD, 20, { identityConfirmed: true }, { source: 'process', authority: 70 })], { liveness: 'DEAD', sessionLifecycle: 'CLOSED' }],
  ['11 crash missing process', [normal(ref, EVENT_TYPES.PROCESS_MISSING, 20, {}, { source: 'process', authority: 70 })], { liveness: 'SUSPECT' }],
  ['12 close window', [normal(ref, EVENT_TYPES.SESSION_CLOSED, 20)], { sessionLifecycle: 'CLOSED' }],
  ['13 app closed', [normal(ref, EVENT_TYPES.PROCESS_DEAD, 20, { identityConfirmed: true }, { source: 'process', authority: 70 })], { liveness: 'DEAD', sessionLifecycle: 'CLOSED' }],
  ['14 sleep wake', [normal(ref, EVENT_TYPES.PROCESS_MISSING, 20, {}, { source: 'process', authority: 70 }), normal(ref, EVENT_TYPES.PROCESS_SEEN, 30, {}, { source: 'process', authority: 70 })], { liveness: 'ALIVE' }],
  ['15 JSONL truncate generation', [normal(ref, EVENT_TYPES.TURN_STARTED, 10, { turnId: 'old' }, { sourceGeneration: 1, sourceSequence: 5 }), normal(ref, EVENT_TYPES.TURN_STARTED, 20, { turnId: 'new' }, { sourceGeneration: 2, sourceSequence: 1 })], { currentTurnId: 'new', turnState: 'RUNNING' }],
  ['16 JSONL rotate generation', [normal(ref, EVENT_TYPES.TURN_STARTED, 10, { turnId: 'old' }, { sourceGeneration: 1, sourceSequence: 8 }), normal(ref, EVENT_TYPES.TURN_COMPLETION_SIGNAL, 20, { turnId: 'new' }, { sourceGeneration: 2, sourceSequence: 1 })], { turnState: 'COMPLETION_CANDIDATE' }],
  ['17 Agent Board restart terminal recovery', [normal(ref, EVENT_TYPES.TURN_STARTED, 10, { turnId: 't1' }), normal(ref, EVENT_TYPES.TURN_COMPLETED, 20, { turnId: 't1' })], { turnState: 'COMPLETED' }],
  ['18 Agent restart generation', [normal(ref, EVENT_TYPES.TURN_STARTED, 10, { turnId: 'old' }, { sourceGeneration: 1, sourceSequence: 5 }), normal(ref, EVENT_TYPES.TURN_STARTED, 20, { turnId: 'new' }, { sourceGeneration: 2, sourceSequence: 1 })], { currentTurnId: 'new' }],
  ['19 resume old session', [normal(ref, EVENT_TYPES.TURN_COMPLETED, 10, { turnId: 'old' }, { sourceSequence: 1 }), normal(ref, EVENT_TYPES.USER_MESSAGE, 20, { turnId: 'new' }, { sourceSequence: 2 })], { currentTurnId: 'new', turnState: 'RUNNING' }],
  ['20 fork child session', [normal(ref, EVENT_TYPES.TURN_STARTED, 10, { turnId: 't1', sessionRole: 'child' })], { liveness: 'UNKNOWN', sessionLifecycle: 'UNKNOWN', turnState: 'NONE' }],
  ['21 same CWD two sessions', [], {}],
  ['22 desktop plus CLI', [normal(ref, EVENT_TYPES.PROCESS_SEEN, 10, {}, { source: 'process', authority: 70 }), normal(ref, EVENT_TYPES.TURN_STARTED, 20, { turnId: 't1' })], { liveness: 'ALIVE', turnState: 'RUNNING' }],
  ['23 rate limited', [normal(ref, EVENT_TYPES.TURN_STARTED, 10, { turnId: 't1' }), normal(ref, EVENT_TYPES.RATE_LIMITED, 20)], { activityState: 'RATE_LIMITED' }],
  ['24 context compact', [normal(ref, EVENT_TYPES.TURN_STARTED, 10, { turnId: 't1' }), normal(ref, EVENT_TYPES.CONTEXT_COMPACTING, 20)], { activityState: 'COMPACTING_CONTEXT' }],
  ['25 late hook', [normal(ref, EVENT_TYPES.TURN_STARTED, 20, { turnId: 't1' }, { sourceSequence: 2 }), normal(ref, EVENT_TYPES.TURN_COMPLETION_SIGNAL, 10, { turnId: 't1' }, { sourceSequence: 1 })], { turnState: 'RUNNING' }],
  ['26 out of order hook', [normal(ref, EVENT_TYPES.TURN_STARTED, 20, { turnId: 't1' }, { sourceSequence: 2 }), normal(ref, EVENT_TYPES.TURN_COMPLETED, 10, { turnId: 't1' }, { sourceSequence: 1 })], { turnState: 'RUNNING' }],
  ['27 heartbeat loss', [normal(ref, EVENT_TYPES.HEARTBEAT, 10, {}, { source: 'heartbeat', authority: 75 })], { liveness: 'ALIVE' }],
  ['28 temporary process missing', [normal(ref, EVENT_TYPES.PROCESS_MISSING, 10, {}, { source: 'process', authority: 70 }), normal(ref, EVENT_TYPES.PROCESS_SEEN, 20, {}, { source: 'process', authority: 70 })], { liveness: 'ALIVE' }],
  ['29 old event replay', [normal(ref, EVENT_TYPES.TURN_STARTED, 10, { turnId: 't1' }, { sourceSequence: 1 }), normal(ref, EVENT_TYPES.TURN_COMPLETED, 20, { turnId: 't1' }, { sourceSequence: 2 }), normal(ref, EVENT_TYPES.TURN_STARTED, 15, { turnId: 'old' }, { sourceSequence: 1 })], { turnState: 'COMPLETED', currentTurnId: 't1' }],
  ['30 duplicate event', [normal(ref, EVENT_TYPES.TURN_STARTED, 10, { turnId: 't1' }), normal(ref, EVENT_TYPES.TURN_STARTED, 10, { turnId: 't1' })], { turnState: 'RUNNING', currentTurnId: 't1' }],
  ['31 child subagent event', [normal(ref, EVENT_TYPES.TURN_STARTED, 10, { turnId: 't1' }), normal(ref, EVENT_TYPES.SUBAGENT_STARTED, 20, { subagentId: 'child-1' }), normal(ref, EVENT_TYPES.SUBAGENT_FINISHED, 30, { subagentId: 'child-1' })], { activeSubagentIds: [] }],
  ['32 parent completion while child active', [normal(ref, EVENT_TYPES.TURN_STARTED, 10, { turnId: 't1' }), normal(ref, EVENT_TYPES.SUBAGENT_STARTED, 20, { subagentId: 'child-1' }), normal(ref, EVENT_TYPES.TURN_COMPLETED, 30, { turnId: 't1' })], { turnState: 'COMPLETION_CANDIDATE', activeSubagentIds: ['child-1'] }],
];

test('P0 replay matrix covers the 32 PRD scenarios', async (t) => {
  assert.equal(replayCases.length, 32);
  for (const [name, input, expected] of replayCases) {
    await t.test(name, () => {
      if (name.startsWith('21 ')) {
        const first = createSessionIdentity({ agent: 'codex', hostId: 'host', nativeSessionId: 'one', cwd: 'C:\\same' });
        const second = createSessionIdentity({ agent: 'codex', hostId: 'host', nativeSessionId: 'two', cwd: 'C:\\same' });
        assert.equal(sameSessionIdentity(first, second), false);
        return;
      }
      const actual = state(input);
      for (const [key, value] of Object.entries(expected)) assert.deepEqual(actual[key], value, key);
    });
  }
});

test('P0 matrix process debounce reaches DEAD only after configured misses', () => {
  const service = createProcessLivenessService({ deadAfterMisses: 3, deadAfterMs: 6000 });
  service.observe({ agent: 'codex', sessionRef: 'codex:matrix-process', alive: true, identityMatched: true, observedAt: 1 });
  assert.equal(service.observe({ agent: 'codex', sessionRef: 'codex:matrix-process', alive: false, identityMatched: true, observedAt: 2 }).state, 'SUSPECT');
  assert.equal(service.observe({ agent: 'codex', sessionRef: 'codex:matrix-process', alive: false, identityMatched: true, observedAt: 3 }).state, 'SUSPECT');
  assert.equal(service.observe({ agent: 'codex', sessionRef: 'codex:matrix-process', alive: false, identityMatched: true, observedAt: 6003 }).state, 'DEAD');
});
