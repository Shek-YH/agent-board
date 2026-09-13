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
