'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { buildRunReceipt } = require('./run-receipt');

test('run receipt records safe progress and loop counters without instruction content', () => {
  const receipt = buildRunReceipt({
    workflow: {
      id: 'wf-1', agent: 'codex', runCount: 2, consecutiveFailures: 1, stagnationCount: 0,
      dispatchFailures: 0, routingEscalations: 0, routingDowngrades: 0,
      runContract: { goal: '完成目标', verify: { dod: ['测试通过'] } },
    },
    finalState: 'PAUSED', stopReason: 'Delivery Unverified', now: 1_700_000_000_000,
    decision: { decision: 'NEED_HUMAN', reasonCode: 'DELIVERY_UNVERIFIED', summary: '需要人工核验送达' },
  });
  assert.equal(receipt.runId, 'wf-1');
  assert.equal(receipt.finalState, 'PAUSED');
  assert.deepEqual(receipt.dod, { passed: 0, total: 1 });
  assert.equal(receipt.stopReason, 'Delivery Unverified');
  assert.equal('instruction' in receipt, false);
  assert.equal(JSON.stringify(receipt).includes('API_KEY'), false);
});

test('run receipt references immutable settings and permission snapshots', () => {
  const receipt = buildRunReceipt({
    workflow: {
      id: 'wf-snapshot-ref', agent: 'codex', runContract: { goal: '完成目标', verify: { dod: ['完成'] } },
      settingsSnapshot: { snapshotId: 'ss-12345678' }, permissionSnapshot: { snapshotId: 'ps-12345678' },
    }, finalState: 'DONE',
  });
  assert.equal(receipt.settingsSnapshotId, 'ss-12345678');
  assert.equal(receipt.permissionSnapshotId, 'ps-12345678');
});

test('run receipt includes a safe routing summary when a route was used', () => {
  const receipt = buildRunReceipt({
    workflow: {
      id: 'wf-2', agent: 'codex', runCount: 1, runContract: { goal: '完成目标', verify: { dod: [] } },
      progress: { completed: 0 },
      lastRouting: {
        enabled: true, action: 'apply', reasonCode: 'MANUAL_PIN', complexityTier: 'C1', thinkingTier: 'T1',
        promptPolicy: 'P1', modelId: 'gpt-5.6-sol', reasoningLevel: 'high', source: 'native', verified: true,
        fallbackApplied: false, catalogSource: 'native', catalogStale: false,
      },
    },
    finalState: 'PAUSED', stopReason: 'Need Human', now: 1_700_000_000_000,
  });
  assert.deepEqual(receipt.routing, {
    enabled: true, action: 'apply', reasonCode: 'MANUAL_PIN', complexityTier: 'C1', thinkingTier: 'T1',
    promptPolicy: 'P1', modelId: 'gpt-5.6-sol', reasoningLevel: 'high', source: 'native', verified: true,
    fallbackApplied: false, catalogSource: 'native', catalogStale: false,
  });
});

test('run receipt V2 uses the accepted turn snapshot and summarizes safe routing outcomes', () => {
  const receipt = buildRunReceipt({
    workflow: {
      id: 'wf-v2', agent: 'codex', runCount: 2,
      runContract: { goal: '完成目标', verify: { dod: ['测试通过'] } },
      progress: { completed: 0 },
      lastRouting: { modelId: 'new-model', reasoningLevel: 'low', verified: true },
      acceptedTurnSnapshot: {
        turnId: 'turn-2', attempt: 2,
        routeRequest: { complexityTier: 'C2', thinkingTier: 'T2', promptPolicy: 'P1' },
        resolvedProfile: { modelId: 'strong', reasoningLevel: 'high' },
        verification: { verified: true, source: 'native' },
      },
      routingAudit: [
        { event: 'ROUTE_ESCALATED' },
        { event: 'MODEL_APPLY_VERIFIED' },
        { event: 'PROFILE_VERIFIED' },
        { event: 'MODEL_APPLY_FAILED', profile: { resultCode: 'PROFILE_VERIFY_FAILED' } },
      ],
      lastDecision: { instruction: 'prompt must not persist', summary: 'safe summary' },
    },
    finalState: 'PAUSED', stopReason: 'Need Human', now: 1_700_000_000_000,
  });

  assert.equal(receipt.version, 2);
  assert.deepEqual(receipt.acceptedTurn, {
    turnId: 'turn-2', attempt: 2,
    routeRequest: { complexityTier: 'C2', thinkingTier: 'T2', promptPolicy: 'P1' },
    resolvedProfile: { modelId: 'strong', reasoningLevel: 'high' },
    verification: { verified: true, source: 'native' },
  });
  assert.deepEqual(receipt.routingSummary, {
    escalations: 1, downgrades: 0, verifiedProfileChanges: 1, failures: 1,
  });
  assert.equal(JSON.stringify(receipt).includes('prompt must not persist'), false);
  assert.equal('instruction' in receipt, false);
});
