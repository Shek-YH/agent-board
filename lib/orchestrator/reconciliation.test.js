'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { reconcilePendingDispatch } = require('./reconciliation');

function makeStore(workflow, wal) {
  return {
    get: () => workflow,
    listPendingWal: () => wal,
    appendWal: (_id, record) => { wal.push({ ...record, state: record.state }); return record; },
    transitionState: (_id, state) => { workflow.autoState = state; return workflow; },
    updateFields: (_id, fields) => { Object.assign(workflow, fields); return workflow; },
  };
}

test('reconciliation never replays a WAL entry that did not reach SEND', async () => {
  const workflow = { id: 'wf-1', autoState: 'DISPATCHING', controlOwner: 'autopilot' };
  const wal = [{ operationId: 'op-1', state: 'pending', sendAttempted: false, instructionFingerprint: 'x' }];
  let verified = false;
  const result = await reconcilePendingDispatch({
    store: makeStore(workflow, wal), workflowId: workflow.id,
    verifyDelivery: async () => { verified = true; return { delivered: true }; },
  });
  assert.equal(result.state, 'PAUSED');
  assert.equal(verified, false);
  assert.equal(wal[1].state, 'reconcile_required');
});

test('reconciliation verifies delivery after SEND and never calls a sender', async () => {
  const workflow = { id: 'wf-1', autoState: 'DISPATCHING', controlOwner: 'autopilot' };
  const wal = [{ operationId: 'op-1', state: 'pending', sendAttempted: true, instruction: '继续完成任务' }];
  let sends = 0;
  const result = await reconcilePendingDispatch({
    store: makeStore(workflow, wal), workflowId: workflow.id,
    verifyDelivery: async (entry) => ({ delivered: entry.instruction === '继续完成任务' }),
    send: async () => { sends += 1; },
  });
  assert.equal(result.state, 'WAITING_AGENT');
  assert.equal(sends, 0);
  assert.equal(wal[1].state, 'committed');
});
