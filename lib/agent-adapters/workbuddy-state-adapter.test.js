'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { EVIDENCE_SOURCES, EVENT_TYPES } = require('../state-engine/enums');
const { createWorkBuddyStateAdapter, hookEventToEvidence, heartbeatToEvidence, databaseStatusToEvidence } = require('./workbuddy-state-adapter');

function hook(event, overrides = {}) {
  return {
    event,
    event_id: `${event}-1`,
    session_id: 'session-1',
    ts: 100,
    tool_use_id: 'tool-1',
    subagent_id: 'child-1',
    task_id: 'task-1',
    prompt: 'do not persist this prompt',
    cwd: 'C:\\private-project',
    ...overrides,
  };
}

test('WorkBuddy lifecycle hooks become metadata-only Evidence', () => {
  const started = hookEventToEvidence(hook('SessionStart'));
  const user = hookEventToEvidence(hook('UserPromptSubmit', { event_id: 'user-1' }));
  const tool = hookEventToEvidence(hook('PreToolUse', { event_id: 'tool-1' }));
  const approval = hookEventToEvidence(hook('PermissionRequest', { event_id: 'permission-1' }));
  const stop = hookEventToEvidence(hook('Stop', { event_id: 'stop-1' }));
  const end = hookEventToEvidence(hook('SessionEnd', { event_id: 'end-1' }));

  assert.equal(started.signalType, EVENT_TYPES.SESSION_STARTED);
  assert.equal(user.signalType, EVENT_TYPES.USER_MESSAGE);
  assert.equal(tool.signalType, EVENT_TYPES.TOOL_STARTED);
  assert.deepEqual(tool.value, { toolId: 'tool-1' });
  assert.equal(approval.signalType, EVENT_TYPES.WAITING_APPROVAL);
  assert.equal(stop.signalType, EVENT_TYPES.TURN_COMPLETION_SIGNAL);
  assert.equal(end.signalType, EVENT_TYPES.SESSION_CLOSED);
  assert.equal(Object.hasOwn(user, 'prompt'), false);
  assert.equal(Object.hasOwn(user, 'cwd'), false);
});

test('WorkBuddy Stop only creates a turn candidate and stop_hook_active does not complete', () => {
  assert.equal(hookEventToEvidence(hook('Stop')).signalType, EVENT_TYPES.TURN_COMPLETION_SIGNAL);
  assert.equal(hookEventToEvidence(hook('Stop', { event_id: 'active-stop', stop_hook_active: true })).signalType, EVENT_TYPES.TRANSCRIPT_ACTIVITY);
  assert.equal(hookEventToEvidence(hook('StopFailure')).signalType, EVENT_TYPES.TURN_FAILED);
});

test('WorkBuddy heartbeat and database status use separate sources and lifecycle meanings', () => {
  const heartbeat = heartbeatToEvidence({ sessionId: 'session-1', lastHeartbeat: 200 }, { observedAt: 210 });
  const database = databaseStatusToEvidence({ sessionId: 'session-1', terminal: true, statusAt: 300 }, { observedAt: 310 });

  assert.equal(heartbeat.source, EVIDENCE_SOURCES.HEARTBEAT);
  assert.equal(heartbeat.signalType, EVENT_TYPES.HEARTBEAT);
  assert.equal(heartbeat.occurredAt, 200);
  assert.equal(database.source, EVIDENCE_SOURCES.DATABASE);
  assert.equal(database.signalType, EVENT_TYPES.SESSION_CLOSED);
  assert.equal(database.occurredAt, 300);
});

test('WorkBuddy adapter emits only in shadow/on modes', () => {
  const off = createWorkBuddyStateAdapter({ mode: 'off' });
  const emitted = [];
  const shadow = createWorkBuddyStateAdapter({ mode: 'shadow', emit: (item) => emitted.push(item) });
  assert.deepEqual(off.collect([hook('Stop')]), []);
  const result = shadow.collect([hook('Stop')]);
  assert.equal(result.length, 1);
  assert.deepEqual(emitted, result);
});

test('WorkBuddy parsed JSONL messages also become metadata-only turn Evidence', () => {
  const user = hookEventToEvidence({
    agent: 'workbuddy', kind: 'message', role: 'user', sessionId: 'session-1', sourceId: 'message-1', ts: 150,
    text: 'private message body', project: 'C:\\private-project',
  });
  const assistant = hookEventToEvidence({
    agent: 'workbuddy', kind: 'message', role: 'assistant', sessionId: 'session-1', sourceId: 'message-2', ts: 160,
    text: 'private response body',
  });

  assert.equal(user.signalType, EVENT_TYPES.USER_MESSAGE);
  assert.equal(assistant.signalType, EVENT_TYPES.ASSISTANT_MESSAGE);
  assert.equal(user.evidence, undefined);
  assert.equal(Object.hasOwn(user, 'text'), false);
});
