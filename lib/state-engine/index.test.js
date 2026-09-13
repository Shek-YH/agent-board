'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createStateEngine } = require('./index');
const { EVENT_TYPES, TURN_STATES } = require('./enums');

function evidence(sessionRef, signalType, timestamp, overrides = {}) {
  return {
    evidenceId: `${sessionRef}:${signalType}:${timestamp}`,
    agent: sessionRef.split(':')[0],
    sessionRef,
    source: 'jsonl',
    signalType,
    value: signalType === EVENT_TYPES.TURN_STARTED ? { turnId: 'turn-1' } : {},
    occurredAt: timestamp,
    observedAt: timestamp,
    sourceSequence: overrides.sourceSequence,
    confidence: 0.99,
    authority: 90,
    ...overrides,
  };
}

test('state engine stays disabled by default and does not create V2 runtime', () => {
  const engine = createStateEngine({ mode: 'off' });
  const result = engine.ingest(evidence('codex:off', EVENT_TYPES.TURN_STARTED, 100));
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'feature_disabled');
  assert.equal(engine.entries().length, 0);
});

test('shadow engine ingests through watermark and reducer and exposes a projection', () => {
  const engine = createStateEngine({ mode: 'shadow' });
  const first = engine.ingest(evidence('codex:one', EVENT_TYPES.TURN_STARTED, 100, { sourceSequence: 1 }));
  const second = engine.ingest(evidence('codex:one', EVENT_TYPES.TURN_COMPLETION_SIGNAL, 200, { sourceSequence: 2 }));
  const projection = engine.project('codex:one');

  assert.equal(first.accepted, true);
  assert.equal(second.accepted, true);
  assert.equal(second.runtime.turnState, TURN_STATES.COMPLETION_CANDIDATE);
  assert.equal(projection.source, 'legacy');
  assert.equal(projection.v2.key, 'completion_candidate');
  assert.equal(engine.entries().length, 1);
  assert.equal(engine.getWatermark('codex:one').sources['codex:codex:one:jsonl'].lastSequence, 2);
});

test('state engine rejects duplicate source evidence but accepts late evidence from another source', () => {
  const engine = createStateEngine({ mode: 'on' });
  const first = engine.ingest(evidence('codex:two', EVENT_TYPES.TURN_STARTED, 200, { sourceSequence: 2 }));
  const duplicate = engine.ingest(evidence('codex:two', EVENT_TYPES.TURN_STARTED, 200, { sourceSequence: 2 }));
  const lateOther = engine.ingest(evidence('codex:two', EVENT_TYPES.HEARTBEAT, 100, {
    source: 'heartbeat', sourceSequence: 1,
  }));

  assert.equal(first.accepted, true);
  assert.equal(duplicate.accepted, false);
  assert.equal(duplicate.reason, 'duplicate_evidence');
  assert.equal(lateOther.accepted, true);
  assert.equal(lateOther.runtime.liveness, 'ALIVE');
});

test('state engine restores terminal state and watermark but does not revive a persisted running turn', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-state-engine-restart-'));
  const persistencePath = path.join(dir, 'state-engine.json');
  try {
    const first = createStateEngine({ mode: 'on', persistencePath });
    first.ingest(evidence('codex:restart', EVENT_TYPES.TURN_STARTED, 100, { sourceSequence: 1 }));
    first.ingest(evidence('codex:restart', EVENT_TYPES.TURN_COMPLETED, 200, { sourceSequence: 2 }));
    const restored = createStateEngine({ mode: 'on', persistencePath });
    assert.equal(restored.get('codex:restart').turnState, TURN_STATES.COMPLETED);
    assert.equal(restored.getWatermark('codex:restart').sources['codex:codex:restart:jsonl'].lastSequence, 2);

    const raw = JSON.parse(fs.readFileSync(persistencePath, 'utf8'));
    raw.sessions[0].runtime.turnState = 'RUNNING';
    raw.sessions[0].runtime.activityState = 'THINKING';
    fs.writeFileSync(persistencePath, JSON.stringify(raw), 'utf8');
    const safeRestored = createStateEngine({ mode: 'on', persistencePath });
    assert.equal(safeRestored.get('codex:restart').turnState, 'NONE');
    assert.equal(safeRestored.get('codex:restart').activityState, 'UNKNOWN');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('state engine completion callback is emitted once per completed turn', () => {
  const notifications = [];
  const engine = createStateEngine({ mode: 'on', onCompletion: (event) => notifications.push(event) });
  engine.ingest(evidence('codex:notify', EVENT_TYPES.TURN_STARTED, 100, { sourceSequence: 1 }));
  engine.ingest(evidence('codex:notify', EVENT_TYPES.TURN_COMPLETED, 200, { sourceSequence: 2 }));
  engine.ingest(evidence('codex:notify', EVENT_TYPES.TURN_COMPLETED, 200, { sourceSequence: 2 }));

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].completionId, 'codex:codex:notify:gen:0:turn-1:200');
  assert.equal(notifications[0].runtime.sessionLifecycle, 'OPEN');
});

test('process observations enter the engine as liveness only and expose safe source health', () => {
  const engine = createStateEngine({ mode: 'on', liveness: { deadAfterMisses: 3 } });
  const result = engine.observeProcess({
    agent: 'codex', sessionRef: 'codex:process', processId: 7,
    processStartedAt: 100, alive: true, identityMatched: true, observedAt: 200,
  });
  const runtime = engine.get('codex:process');

  assert.equal(result.accepted, true);
  assert.equal(runtime.liveness, 'ALIVE');
  assert.equal(runtime.turnState, 'NONE');
  assert.equal(runtime.activityState, 'UNKNOWN');
  assert.deepEqual(engine.getSourceHealth(), { process: 'HEALTHY' });
});

test('manual State Engine actions separate seen, turn done, and session close', () => {
  const engine = createStateEngine({ mode: 'on' });
  engine.ingest(evidence('codex:manual', EVENT_TYPES.TURN_STARTED, 100, { sourceSequence: 1 }));
  assert.equal(engine.markTurnDone('codex:manual', 'turn-1').turnState, 'COMPLETED');
  assert.equal(engine.get('codex:manual').sessionLifecycle, 'OPEN');
  assert.equal(engine.markSeen('codex:manual').attentionState, 'NONE');
  assert.equal(engine.closeSession('codex:manual').sessionLifecycle, 'CLOSED');
  assert.equal(engine.get('codex:manual').turnState, 'COMPLETED');
});

test('queued ingestion coalesces high-frequency Evidence before reducing it', () => {
  const engine = createStateEngine({ mode: 'on', queueMaxSize: 4 });
  const result = engine.ingestQueued([
    evidence('codex:queue', EVENT_TYPES.HEARTBEAT, 100, { source: 'heartbeat', authority: 75 }),
    evidence('codex:queue', EVENT_TYPES.HEARTBEAT, 110, { source: 'heartbeat', authority: 75 }),
    evidence('codex:queue', EVENT_TYPES.TURN_STARTED, 120),
  ]);

  assert.equal(result.results.length, 2);
  assert.equal(result.coalesced, 1);
  assert.equal(engine.get('codex:queue').liveness, 'ALIVE');
  assert.equal(engine.get('codex:queue').turnState, 'RUNNING');
});
