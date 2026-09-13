'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { EVENT_TYPES, ACTIVITY_STATES, ATTENTION_STATES, LIVENESS_STATES, SESSION_LIFECYCLE_STATES, TURN_STATES } = require('./enums');
const { createInitialRuntime } = require('./runtime');
const { reduceEvidence } = require('./reducer');

function evidence(signalType, timestamp, value = {}, overrides = {}) {
  return {
    evidenceId: `${signalType}:${timestamp}:${overrides.evidenceId || ''}`,
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

function apply(...events) {
  return events.reduce((runtime, event) => reduceEvidence(runtime, event), createInitialRuntime({ sessionRef: 'codex:session-1' }));
}

test('turn completion never closes an open session', () => {
  const candidate = apply(
    evidence(EVENT_TYPES.TURN_STARTED, 100, { turnId: 'turn-1' }),
    evidence(EVENT_TYPES.TURN_COMPLETION_SIGNAL, 200, { turnId: 'turn-1' }),
  );
  const completed = reduceEvidence(candidate, evidence(EVENT_TYPES.TURN_COMPLETED, 210, { turnId: 'turn-1' }));

  assert.equal(candidate.sessionLifecycle, SESSION_LIFECYCLE_STATES.OPEN);
  assert.equal(candidate.turnState, TURN_STATES.COMPLETION_CANDIDATE);
  assert.equal(completed.sessionLifecycle, SESSION_LIFECYCLE_STATES.OPEN);
  assert.equal(completed.turnState, TURN_STATES.COMPLETED);
  assert.equal(completed.activityState, ACTIVITY_STATES.IDLE);
  assert.equal(completed.attentionState, ATTENTION_STATES.COMPLETED_UNSEEN);
});

test('new user activity vetoes a completion candidate and starts a new turn', () => {
  const candidate = apply(
    evidence(EVENT_TYPES.TURN_STARTED, 100, { turnId: 'turn-1' }),
    evidence(EVENT_TYPES.TURN_COMPLETION_SIGNAL, 200, { turnId: 'turn-1' }),
  );
  const resumed = reduceEvidence(candidate, evidence(EVENT_TYPES.USER_MESSAGE, 300, { turnId: 'turn-2' }));

  assert.equal(resumed.turnState, TURN_STATES.RUNNING);
  assert.equal(resumed.currentTurnId, 'turn-2');
  assert.equal(resumed.attentionState, ATTENTION_STATES.NONE);
  assert.equal(resumed.sessionLifecycle, SESSION_LIFECYCLE_STATES.OPEN);
});

test('tool, wait, and heartbeat evidence affect only their canonical dimensions', () => {
  const started = apply(evidence(EVENT_TYPES.TURN_STARTED, 100, { turnId: 'turn-1' }));
  const command = reduceEvidence(started, evidence(EVENT_TYPES.TOOL_STARTED, 110, { toolId: 'tool-1', kind: 'command' }));
  const heartbeat = reduceEvidence(command, evidence(EVENT_TYPES.HEARTBEAT, 120));
  const approval = reduceEvidence(heartbeat, evidence(EVENT_TYPES.WAITING_APPROVAL, 130));

  assert.deepEqual(command.activeToolIds, ['tool-1']);
  assert.equal(command.activityState, ACTIVITY_STATES.RUNNING_COMMAND);
  assert.equal(heartbeat.liveness, LIVENESS_STATES.ALIVE);
  assert.equal(heartbeat.turnState, TURN_STATES.RUNNING);
  assert.equal(heartbeat.activityState, ACTIVITY_STATES.RUNNING_COMMAND);
  assert.equal(approval.activityState, ACTIVITY_STATES.WAITING_APPROVAL);
  assert.equal(approval.attentionState, ATTENTION_STATES.ACTION_REQUIRED);
});

test('failed and interrupted turns remain distinct and do not close the session', () => {
  const failed = apply(
    evidence(EVENT_TYPES.TURN_STARTED, 100, { turnId: 'turn-f' }),
    evidence(EVENT_TYPES.TURN_FAILED, 200, { turnId: 'turn-f' }),
  );
  const interrupted = apply(
    evidence(EVENT_TYPES.TURN_STARTED, 100, { turnId: 'turn-i' }),
    evidence(EVENT_TYPES.TURN_INTERRUPTED, 200, { turnId: 'turn-i' }),
  );

  assert.equal(failed.turnState, TURN_STATES.FAILED);
  assert.equal(failed.attentionState, ATTENTION_STATES.FAILED_UNSEEN);
  assert.equal(interrupted.turnState, TURN_STATES.INTERRUPTED);
  assert.equal(interrupted.attentionState, ATTENTION_STATES.INTERRUPTED_UNSEEN);
  assert.equal(failed.sessionLifecycle, SESSION_LIFECYCLE_STATES.OPEN);
  assert.equal(interrupted.sessionLifecycle, SESSION_LIFECYCLE_STATES.OPEN);
});

test('parent completion waits for active subagents and duplicate evidence is idempotent', () => {
  const started = apply(
    evidence(EVENT_TYPES.TURN_STARTED, 100, { turnId: 'turn-1' }),
    evidence(EVENT_TYPES.SUBAGENT_STARTED, 110, { subagentId: 'child-1' }),
    evidence(EVENT_TYPES.TURN_COMPLETION_SIGNAL, 120, { turnId: 'turn-1' }),
  );
  const finishedChild = reduceEvidence(started, evidence(EVENT_TYPES.SUBAGENT_FINISHED, 130, { subagentId: 'child-1' }));
  const confirmed = reduceEvidence(finishedChild, evidence(EVENT_TYPES.TURN_COMPLETED, 140, { turnId: 'turn-1' }));
  const duplicate = reduceEvidence(confirmed, evidence(EVENT_TYPES.TURN_COMPLETED, 140, { turnId: 'turn-1' }));

  assert.equal(started.turnState, TURN_STATES.COMPLETION_CANDIDATE);
  assert.deepEqual(started.activeSubagentIds, ['child-1']);
  assert.equal(finishedChild.turnState, TURN_STATES.COMPLETION_CANDIDATE);
  assert.equal(confirmed.turnState, TURN_STATES.COMPLETED);
  assert.deepEqual(duplicate, confirmed);
});

test('session end closes the session without rewriting a completed turn', () => {
  const completed = apply(
    evidence(EVENT_TYPES.TURN_STARTED, 100, { turnId: 'turn-1' }),
    evidence(EVENT_TYPES.TURN_COMPLETED, 200, { turnId: 'turn-1' }),
  );
  const closed = reduceEvidence(completed, evidence(EVENT_TYPES.SESSION_CLOSED, 300));

  assert.equal(closed.sessionLifecycle, SESSION_LIFECYCLE_STATES.CLOSED);
  assert.equal(closed.turnState, TURN_STATES.COMPLETED);
});
