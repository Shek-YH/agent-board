'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { arbitrateEvidence, CODEX_SOURCE_AUTHORITY_POLICY, WORKBUDDY_SOURCE_AUTHORITY_POLICY } = require('./arbitrator');

function evidence(overrides = {}) {
  return {
    evidenceId: 'ev-1',
    agent: 'codex',
    sessionRef: 'codex:session-1',
    source: 'jsonl',
    signalType: 'TURN_COMPLETED',
    occurredAt: 100,
    observedAt: 100,
    confidence: 0.9,
    authority: 90,
    ...overrides,
  };
}

test('arbitration chooses authority before arrival time', () => {
  const result = arbitrateEvidence('activityState', [
    evidence({ evidenceId: 'jsonl', source: 'jsonl', observedAt: 100, signalType: 'THINKING' }),
    evidence({ evidenceId: 'ui', source: 'ui', observedAt: 200, signalType: 'IDLE' }),
  ], { now: 250 });

  assert.equal(result.winner.evidenceId, 'jsonl');
  assert.equal(result.ignored[0].evidenceId, 'ui');
  assert.equal(result.ignored[0].reason, 'lower_authority');
});

test('arbitration uses generation, sequence, then event clocks as deterministic tie breakers', () => {
  const result = arbitrateEvidence('turnState', [
    evidence({ evidenceId: 'old', source: 'native_hook', sourceGeneration: 1, sourceSequence: 8, occurredAt: 300 }),
    evidence({ evidenceId: 'new-generation', source: 'native_hook', sourceGeneration: 2, sourceSequence: 1, occurredAt: 100 }),
    evidence({ evidenceId: 'new-sequence', source: 'native_hook', sourceGeneration: 2, sourceSequence: 2, occurredAt: 50 }),
  ], { policy: CODEX_SOURCE_AUTHORITY_POLICY, now: 400 });

  assert.equal(result.winner.evidenceId, 'new-sequence');
  assert.equal(result.ignored.length, 2);
  assert.ok(result.ignored.every((item) => item.reason === 'older_tiebreaker'));
});

test('expired evidence is ignored and returns no winner when every candidate is stale', () => {
  const result = arbitrateEvidence('liveness', [
    evidence({ source: 'heartbeat', observedAt: 100, signalType: 'HEARTBEAT' }),
  ], { now: 45_100 });

  assert.equal(result.winner, null);
  assert.deepEqual(result.ignored, [{ evidenceId: 'ev-1', reason: 'expired' }]);
});

test('agent policies declare lifecycle authority independently from generic defaults', () => {
  assert.equal(CODEX_SOURCE_AUTHORITY_POLICY.fullLifecycleAuthority, false);
  assert.equal(WORKBUDDY_SOURCE_AUTHORITY_POLICY.fullLifecycleAuthority, true);
  assert.equal(WORKBUDDY_SOURCE_AUTHORITY_POLICY.authority.sessionLifecycle.native_hook, 100);
});
