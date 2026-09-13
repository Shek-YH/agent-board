'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { EVENT_TYPES, SESSION_LIFECYCLE_STATES, TURN_STATES, LIVENESS_STATES } = require('./enums');
const { createStateEngineStoreBridge } = require('./store-bridge');

function legacy(kind, sourceId, ts, extra = {}) {
  return {
    agent: 'codex', sessionId: 'session-1', sourceId, kind, ts,
    turnId: 'turn-1', ...extra,
  };
}

test('shadow bridge sends Codex legacy events to V2 without changing the legacy snapshot source', () => {
  const bridge = createStateEngineStoreBridge({ mode: 'shadow' });
  const started = bridge.ingest(legacy('turn_start', 'start-1', 100));
  const candidate = bridge.ingest(legacy('turn_end', 'complete-1', 200, { turnStatus: 'completed' }));
  const status = bridge.getStatus('codex:session-1');

  assert.equal(started.accepted, true);
  assert.equal(candidate.accepted, true);
  assert.equal(candidate.runtime.turnState, TURN_STATES.COMPLETION_CANDIDATE);
  assert.equal(status.mode, 'shadow');
  assert.equal(status.source, 'legacy');
  assert.equal(status.canonical_state.sessionLifecycle, SESSION_LIFECYCLE_STATES.OPEN);
  assert.equal(status.canonical_state.turnState, TURN_STATES.COMPLETION_CANDIDATE);
  assert.equal(status.legacy_state, 'running');
});

test('on bridge exposes V2 canonical and UI projections while preserving legacy state', () => {
  const bridge = createStateEngineStoreBridge({ mode: 'on' });
  bridge.ingest(legacy('turn_start', 'start-1', 100));
  bridge.ingest(legacy('turn_end', 'complete-1', 200, { turnStatus: 'completed' }));
  const status = bridge.getStatus('codex:session-1');

  assert.equal(status.mode, 'on');
  assert.equal(status.source, 'state-engine-v2');
  assert.equal(status.ui_status.key, 'completion_candidate');
  assert.equal(status.legacy_state, 'running');
});

test('off bridge does not create a runtime', () => {
  const bridge = createStateEngineStoreBridge({ mode: 'off' });
  assert.equal(bridge.ingest(legacy('turn_start', 'start-1', 100)).reason, 'feature_disabled');
  assert.equal(bridge.getStatus('codex:session-1'), null);
});

test('bridge keeps WorkBuddy Stop as a candidate, closes only on SessionEnd, and limits heartbeat to liveness', () => {
  const bridge = createStateEngineStoreBridge({ mode: 'on' });
  bridge.ingestWorkBuddy({ event: 'UserPromptSubmit', event_id: 'user-1', session_id: 'session-1', ts: 100 });
  bridge.ingestWorkBuddy({ event: 'Stop', event_id: 'stop-1', session_id: 'session-1', ts: 200 });
  const candidate = bridge.getStatus('workbuddy:session-1');
  bridge.ingestWorkBuddyHeartbeat({ sessionId: 'session-1', lastHeartbeat: 210 }, { observedAt: 220 });
  const alive = bridge.getStatus('workbuddy:session-1');
  bridge.ingestWorkBuddy({ event: 'SessionEnd', event_id: 'end-1', session_id: 'session-1', ts: 300 });
  const closed = bridge.getStatus('workbuddy:session-1');

  assert.equal(candidate.canonical_state.turnState, TURN_STATES.COMPLETION_CANDIDATE);
  assert.equal(candidate.canonical_state.sessionLifecycle, SESSION_LIFECYCLE_STATES.OPEN);
  assert.equal(alive.canonical_state.liveness, LIVENESS_STATES.ALIVE);
  assert.equal(alive.canonical_state.turnState, TURN_STATES.COMPLETION_CANDIDATE);
  assert.equal(closed.canonical_state.sessionLifecycle, SESSION_LIFECYCLE_STATES.CLOSED);
});
