'use strict';

function resultWithState(workflow, state) {
  return { ...workflow, autoState: state, state };
}

async function reconcilePendingDispatch({ store, workflowId, verifyDelivery } = {}) {
  if (!store || typeof store.get !== 'function' || typeof store.listPendingWal !== 'function') {
    throw new TypeError('workflow store is required');
  }
  const workflow = store.get(workflowId);
  if (!workflow) return null;
  const pending = store.listPendingWal(workflowId);
  if (!pending.length) return resultWithState(workflow, workflow.autoState || 'OFF');
  const entry = pending[pending.length - 1];
  if (!entry.sendAttempted) {
    store.appendWal(workflowId, {
      ...entry, state: 'reconcile_required', phase: 'RECOVERY', sendAttempted: false,
      reason: 'Crash before SEND; automatic replay is forbidden',
    });
    if (typeof store.updateFields === 'function') store.updateFields(workflowId, { stopReason: 'Identity Unverified' }, 'reconcile_required');
    if (typeof store.transitionState === 'function' && workflow.autoState !== 'PAUSED') store.transitionState(workflowId, 'PAUSED', 'reconcile_paused');
    return resultWithState(store.get(workflowId) || workflow, 'PAUSED');
  }

  let delivery = null;
  try {
    if (typeof verifyDelivery === 'function') delivery = await verifyDelivery(entry);
  } catch { delivery = null; }
  if (delivery && delivery.delivered === true) {
    store.appendWal(workflowId, { ...entry, state: 'committed', phase: 'RECOVERY_VERIFY_DELIVERY', sendAttempted: true });
    if (typeof store.transitionState === 'function' && workflow.autoState !== 'WAITING_AGENT') {
      if (workflow.autoState === 'DISPATCHING') store.transitionState(workflowId, 'VERIFYING', 'reconcile_verifying');
      if ((store.get(workflowId) || workflow).autoState !== 'WAITING_AGENT') {
        store.transitionState(workflowId, 'WAITING_AGENT', 'reconcile_verified');
      }
    }
    return resultWithState(store.get(workflowId) || workflow, 'WAITING_AGENT');
  }

  store.appendWal(workflowId, {
    ...entry, state: 'reconcile_required', phase: 'RECOVERY_VERIFY_DELIVERY', sendAttempted: true,
    reason: 'SEND reached an uncertain state; delivery could not be verified',
  });
  if (typeof store.updateFields === 'function') store.updateFields(workflowId, { stopReason: 'Delivery Unverified' }, 'reconcile_required');
  if (typeof store.transitionState === 'function' && workflow.autoState !== 'PAUSED') store.transitionState(workflowId, 'PAUSED', 'reconcile_paused');
  return resultWithState(store.get(workflowId) || workflow, 'PAUSED');
}

module.exports = { reconcilePendingDispatch };
