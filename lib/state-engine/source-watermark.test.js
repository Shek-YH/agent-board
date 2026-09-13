'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { acceptEvidence, createSourceWatermarks, sourceKey } = require('./source-watermark');

function evidence(overrides = {}) {
  return {
    evidenceId: 'ev-1',
    agent: 'codex',
    sessionRef: 'codex:session-1',
    source: 'process',
    signalType: 'PROCESS_SEEN',
    occurredAt: 100,
    observedAt: 100,
    confidence: 0.9,
    authority: 70,
    ...overrides,
  };
}

test('source watermarks do not let a newer source timestamp discard a later-observed source', () => {
  const first = acceptEvidence(createSourceWatermarks(), evidence({ sourceSequence: 4, observedAt: 200 }));
  const laterObservedOtherSource = acceptEvidence(first.state, evidence({
    evidenceId: 'ev-2', source: 'jsonl', signalType: 'TURN_COMPLETED', occurredAt: 100, observedAt: 100,
    sourceSequence: 1,
  }));

  assert.equal(first.accepted, true);
  assert.equal(laterObservedOtherSource.accepted, true);
  assert.equal(laterObservedOtherSource.state.sources[sourceKey(evidence({ source: 'jsonl' }))].lastObservedAt, 100);
});

test('source watermarks reject duplicate and same-generation out-of-order sequences', () => {
  const initial = createSourceWatermarks();
  const accepted = acceptEvidence(initial, evidence({ sourceSequence: 4 }));
  const duplicate = acceptEvidence(accepted.state, evidence({ sourceSequence: 4 }));
  const stale = acceptEvidence(accepted.state, evidence({ evidenceId: 'ev-2', sourceSequence: 3, observedAt: 300 }));

  assert.equal(accepted.accepted, true);
  assert.equal(duplicate.accepted, false);
  assert.equal(duplicate.reason, 'duplicate_evidence');
  assert.equal(stale.accepted, false);
  assert.equal(stale.reason, 'out_of_order_sequence');
});

test('a new source generation resets sequence and offset without changing another source', () => {
  const process = acceptEvidence(createSourceWatermarks(), evidence({ sourceSequence: 9, sourceGeneration: 1, evidence: { offset: 90 } }));
  const jsonl = acceptEvidence(process.state, evidence({
    evidenceId: 'jsonl-1', source: 'jsonl', sourceSequence: 2, sourceGeneration: 1,
  }));
  const restarted = acceptEvidence(jsonl.state, evidence({
    evidenceId: 'ev-2', sourceSequence: 1, sourceGeneration: 2, evidence: { offset: 1 },
  }));
  const key = sourceKey(evidence());
  const jsonlKey = sourceKey(evidence({ source: 'jsonl' }));

  assert.equal(restarted.accepted, true);
  assert.deepEqual(restarted.state.sources[key], {
    generation: 2, lastSequence: 1, lastOffset: 1, lastObservedAt: 100,
  });
  assert.equal(restarted.state.sources[jsonlKey].generation, 1);
  assert.equal(restarted.state.sources[jsonlKey].lastSequence, 2);
});

