'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { normalizeRunContract } = require('./run-contract');
const { WorkflowStore } = require('./workflow-store');
const { AutoLoop } = require('./auto-loop');

function setup({ dispatchResult } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-auto-'));
  const projectPath = path.join(dir, 'app');
  const store = new WorkflowStore(path.join(dir, 'workflows.json'));
  const workflow = store.create({
    projectPath, agent: 'codex', binding: { sessionRef: 'session-1', agent: 'codex', projectPath },
    runContract: normalizeRunContract({ autopilotMode: 'auto', goal: '完成目标', verify: { dod: ['测试通过'] } }),
  });
  let sends = 0;
  const dependencies = {
    resolveSession: async () => ({
      status: 'resolved',
      target: { sessionRef: 'session-1', agent: 'codex', project: projectPath, role: 'main', controlEligibility: 'eligible' },
      candidates: [{ sessionRef: 'session-1', agent: 'codex', project: projectPath, role: 'main', controlEligibility: 'eligible' }],
    }),
    verifySession: async () => ({ ok: true, strongAnchor: true, anchor: 'anchor-1' }),
    activateSession: async () => ({ ok: true }),
    captureDeliverySnapshot: async () => ({ lastMessageId: 'before' }),
    writer: {
      write: async () => ({ ok: true, matches: true }),
      send: async () => { sends += 1; return { ok: true }; },
    },
    verifyDraft: async () => ({ ok: true, matches: true }),
    verifyDelivery: async () => ({ ok: true, delivered: true }),
    completionDetector: { detect: async () => null },
  };
  if (dispatchResult) dependencies.dispatchResult = dispatchResult;
  const loop = new AutoLoop({
    store, allowedRoots: [dir], resolveDependencies: () => dependencies, resolveCompletionDetector: () => dependencies.completionDetector,
    dispatch: async (request, injected) => {
      const result = await require('../verified-dispatch').dispatchVerifiedMessage(request, injected);
      return dependencies.dispatchResult || result;
    }, now: () => 2_000,
  });
  return { dir, store, workflow, loop, sends: () => sends };
}

test('auto loop performs one verified single-session turn and waits for the agent', async () => {
  const { store, workflow, loop, sends } = setup();
  const result = await loop.run(workflow.id);
  assert.equal(result.autoState, 'WAITING_AGENT');
  assert.equal(result.status, 'running');
  assert.equal(result.runCount, 1);
  assert.equal(result.lastDecision.decision, 'CONTINUE');
  assert.equal(result.lastTurnContract.action, 'repair');
  assert.equal(sends(), 1);
  assert.equal(store.listPendingWal(workflow.id).length, 0);
  assert.equal(store.listWal(workflow.id).length, 2);
  assert.equal(store.listDispatchRecords(workflow.id).length, 1);
});

test('auto loop completes only after explicit DoD evidence and never sends a duplicate turn', async () => {
  const { store, workflow, loop, sends } = setup();
  await loop.run(workflow.id);
  store.recordEvidence(workflow.id, { dodIndex: 0, passed: true, summary: '测试通过', source: 'node --test' });
  const result = await loop.run(workflow.id);
  assert.equal(result.autoState, 'DONE');
  assert.equal(result.status, 'completed');
  assert.equal(result.runCount, 1);
  assert.equal(result.runReceipt.finalState, 'DONE');
  assert.equal(sends(), 1);
});

test('auto loop fails closed when the session is not bound or verified', async () => {
  const { store, workflow, loop, sends } = setup();
  store.updateFields(workflow.id, { binding: null }, 'test_unbound');
  const result = await loop.run(workflow.id);
  assert.equal(result.autoState, 'PAUSED');
  assert.equal(result.stopReason, 'Identity Unverified');
  assert.equal(sends(), 0);
});

test('auto loop pauses after uncertain SEND and recovery never calls SEND again', async () => {
  const uncertain = { ok: false, status: 'reconciliation_required', reconciliationRequired: true, phase: 'SEND' };
  const { store, workflow, loop, sends } = setup({ dispatchResult: uncertain });
  const result = await loop.run(workflow.id);
  assert.equal(result.autoState, 'PAUSED');
  assert.equal(result.stopReason, 'Delivery Unverified');
  assert.equal(sends(), 1);
  const recovered = await loop.reconcile(workflow.id);
  assert.equal(recovered.autoState, 'PAUSED');
  assert.equal(sends(), 1);
  const stillPaused = await loop.run(workflow.id);
  assert.equal(stillPaused.autoState, 'PAUSED');
  assert.equal(sends(), 1);
});
