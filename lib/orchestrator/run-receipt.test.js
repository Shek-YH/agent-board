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

