'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { normalizeRunContract } = require('./run-contract');
const { WorkflowStore } = require('./workflow-store');
const { AutoLoop } = require('./auto-loop');

function setup({ dispatchResult, routingRuntime = null, verifyDeliveryFingerprint = null } = {}) {
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
    captureDeliverySnapshot: async () => ({
      agent: 'codex', threadId: 'thread-1', filePath: path.join(projectPath, 'session.jsonl'),
      byteOffset: 0, sessionSeqBefore: 4, capturedAt: 1_000,
    }),
    writer: {
      write: async () => ({ ok: true, matches: true }),
      send: async () => { sends += 1; return { ok: true }; },
    },
    verifyDraft: async () => ({ ok: true, matches: true }),
    verifyDelivery: async () => ({ ok: true, delivered: true }),
    completionDetector: { detect: async () => null },
  };
  if (dispatchResult) dependencies.dispatchResult = dispatchResult;
  if (verifyDeliveryFingerprint) dependencies.verifyDeliveryFingerprint = verifyDeliveryFingerprint;
  const loop = new AutoLoop({
    store, allowedRoots: [dir], resolveDependencies: () => dependencies, resolveCompletionDetector: () => dependencies.completionDetector,
    routingRuntime,
    dispatch: async (request, injected) => {
      const result = await require('../verified-dispatch').dispatchVerifiedMessage(request, injected);
      return dependencies.dispatchResult || result;
    }, now: () => 2_000,
  });
  return { dir, store, workflow, loop, dependencies, sends: () => sends };
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
  const dispatchRecord = store.listDispatchRecords(workflow.id)[0];
  assert.equal(dispatchRecord.identityProof.verified, true);
  assert.equal(dispatchRecord.identityProof.strongAnchor, true);
  assert.equal(dispatchRecord.deliveryProof.verified, true);
  assert.equal(dispatchRecord.deliveryProof.delivered, true);
  assert.equal(dispatchRecord.sessionSeqBefore, 4);
  assert.equal(dispatchRecord.startedAt, 2_000);
  assert.equal(dispatchRecord.completedAt, 2_000);
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

test('auto loop applies and records a verified route before the first dispatch', async () => {
  const calls = [];
  const { store, workflow, loop } = setup({
    routingRuntime: {
      prepare: async () => {
        calls.push('route');
        return {
          decision: {
            enabled: true, action: 'apply', reasonCode: 'ROUTE_ESCALATED',
            routeRequest: { complexityTier: 'C2', thinkingTier: 'T2', promptPolicy: 'P1' },
            resolvedProfile: { modelId: 'strong', reasoningLevel: 'high' },
            catalog: { source: 'native', stale: false },
          },
          profileResult: { ok: true, source: 'native', verified: true, readback: { modelId: 'strong', reasoningLevel: 'high' } },
          auditEvent: { schemaVersion: 1, event: 'profile_verified', fingerprint: 'route-1' },
        };
      },
    },
  });
  const originalDispatch = loop.dispatch;
  loop.dispatch = async (...args) => { calls.push('dispatch'); return originalDispatch(...args); };

  const result = await loop.run(workflow.id);

  assert.deepEqual(calls, ['route', 'dispatch']);
  assert.deepEqual(result.lastRouting, {
    enabled: true, action: 'apply', reasonCode: 'ROUTE_ESCALATED', complexityTier: 'C2', thinkingTier: 'T2',
    promptPolicy: 'P1', modelId: 'strong', reasoningLevel: 'high', source: 'native', verified: true,
    fallbackApplied: false, catalogSource: 'native', catalogStale: false,
  });
  assert.equal(result.routingEscalations, 1);
  assert.equal(store.listDispatchRecords(workflow.id)[0].routing.modelId, 'strong');
});

test('auto loop pauses on profile verification failure without attempting SEND', async () => {
  const { store, workflow, loop, sends } = setup({
    routingRuntime: {
      prepare: async () => ({
        decision: {
          enabled: true, action: 'apply', reasonCode: 'ROUTE_ESCALATED',
          routeRequest: { complexityTier: 'C2', thinkingTier: 'T2', promptPolicy: 'P1' },
          resolvedProfile: { modelId: 'strong', reasoningLevel: 'high' },
          catalog: { source: 'native', stale: false },
        },
        profileResult: { ok: false, code: 'PROFILE_VERIFY_FAILED', error: 'readback drift' },
        auditEvent: { schemaVersion: 1, event: 'profile_verify_failed', fingerprint: 'route-2' },
      }),
    },
  });

  const result = await loop.run(workflow.id);

  assert.equal(result.autoState, 'PAUSED');
  assert.equal(result.stopReason, 'Profile Apply Unverified');
  assert.equal(result.runCount, 0);
  assert.equal(sends(), 0);
  assert.equal(result.lastRouting.reasonCode, 'ROUTE_ESCALATED');
  assert.equal(store.listWal(workflow.id).length, 0);
});

test('auto loop pauses for human review after the highest-tier route fails', async () => {
  const { store, workflow, loop, sends } = setup({
    routingRuntime: {
      prepare: async () => ({
        decision: {
          enabled: true, action: 'pause', reasonCode: 'NEED_HUMAN_HIGHEST_TIER_FAILURE',
          routeRequest: { complexityTier: 'C3', thinkingTier: 'T3', promptPolicy: 'P2' },
          resolvedProfile: null, catalog: { source: 'native', stale: false },
        },
        profileResult: null,
        auditEvent: { schemaVersion: 1, event: 'routing_decision', fingerprint: 'route-3' },
      }),
    },
  });

  const result = await loop.run(workflow.id);

  assert.equal(result.autoState, 'PAUSED');
  assert.equal(result.stopReason, 'Need Human');
  assert.equal(result.runCount, 0);
  assert.equal(result.lastRouting.reasonCode, 'NEED_HUMAN_HIGHEST_TIER_FAILURE');
  assert.equal(sends(), 0);
  assert.equal(store.listWal(workflow.id).length, 0);
});

test('auto loop records canonical routing audit events and dispatches the accepted immutable profile', async () => {
  const { store, workflow, loop } = setup({
    routingRuntime: {
      prepare: async () => ({
        decision: {
          enabled: true, action: 'apply', reasonCode: 'ROUTE_ESCALATED',
          routeRequest: { complexityTier: 'C2', thinkingTier: 'T2', promptPolicy: 'P1' },
          resolvedProfile: { modelId: 'strong', reasoningLevel: 'high' },
          catalog: { source: 'native', stale: false },
        },
        profileResult: { ok: true, source: 'native', verified: true, readback: { modelId: 'strong', reasoningLevel: 'high' } },
      }),
    },
  });
  store.updateFields(workflow.id, { routingConfig: { enabled: true, preset: 'balanced' } }, 'routing_enabled');

  const result = await loop.run(workflow.id);
  const events = result.routingAudit.map((item) => item.event);
  const snapshot = result.acceptedTurnSnapshot;

  assert.ok(events.includes('ROUTE_REQUESTED'));
  assert.ok(events.includes('ROUTE_RESOLVED'));
  assert.ok(events.includes('MODEL_APPLY_STARTED'));
  assert.ok(events.includes('MODEL_APPLY_VERIFIED'));
  assert.equal(snapshot.resolvedProfile.modelId, 'strong');
  store.updateFields(workflow.id, { routingConfig: { enabled: true, preset: 'save' } }, 'routing_changed');
  assert.equal(store.get(workflow.id).acceptedTurnSnapshot.resolvedProfile.modelId, 'strong');
  assert.equal(store.listDispatchRecords(workflow.id)[0].routing.modelId, 'strong');
});

test('auto loop reconciles an Apply crash by reading the actual profile and never re-applies it', async () => {
  const { store, workflow, loop, sends } = setup();
  store.transitionState(workflow.id, 'PREFLIGHT');
  store.transitionState(workflow.id, 'WAITING_AGENT');
  store.transitionState(workflow.id, 'REVIEWING');
  store.appendWal(workflow.id, {
    operationId: 'profile-op', kind: 'profile_apply', state: 'pending', phase: 'MODEL_APPLY',
    routeRequest: { complexityTier: 'C2', thinkingTier: 'T2', promptPolicy: 'P1' },
    resolvedProfile: { modelId: 'strong', reasoningLevel: 'high' },
  });
  const calls = [];
  loop.routingRuntime = {
    readProfile: async ({ profile }) => {
      calls.push(profile.modelId);
      return { modelId: 'strong', reasoningLevel: 'high' };
    },
    prepare: async () => { throw new Error('must not re-apply during recovery'); },
  };

  const reconciled = await loop.reconcile(workflow.id);

  assert.deepEqual(calls, ['strong']);
  assert.equal(sends(), 0);
  assert.equal(reconciled.profileApplyReconciled, true);
  assert.equal(store.listPendingWal(workflow.id).length, 0);
  assert.ok(reconciled.routingAudit.some((item) => item.event === 'MODEL_APPLY_VERIFIED'));

  const resumed = await loop.run(workflow.id);
  assert.equal(resumed.runCount, 1);
  assert.equal(sends(), 1);
  assert.equal(resumed.acceptedTurnSnapshot.resolvedProfile.modelId, 'strong');
});

test('auto loop fails closed when Apply recovery cannot safely read the actual profile', async () => {
  const { store, workflow, loop, sends } = setup();
  store.appendWal(workflow.id, {
    operationId: 'profile-op', kind: 'profile_apply', state: 'pending', phase: 'MODEL_APPLY',
    resolvedProfile: { modelId: 'strong', reasoningLevel: 'high' },
  });

  const result = await loop.reconcile(workflow.id);

  assert.equal(result.autoState, 'PAUSED');
  assert.equal(result.stopReason, 'Profile Apply Unverified');
  assert.equal(sends(), 0);
  assert.ok(result.routingAudit.some((item) => item.event === 'PROFILE_UNVERIFIED'));
});

test('auto loop reconciles an uncertain SEND with a fingerprint-only delivery verifier', async () => {
  let verifyCalls = 0;
  const { store, workflow, loop, sends } = setup({
    verifyDeliveryFingerprint: async (_target, fingerprint, context) => {
      verifyCalls += 1;
      assert.equal(fingerprint, 'instruction-fingerprint');
      assert.equal(context.snapshot.byteOffset, 0);
      return { ok: true, delivered: true, fingerprintVerified: true };
    },
  });
  for (const state of ['PREFLIGHT', 'WAITING_AGENT', 'REVIEWING', 'DISPATCHING']) store.transitionState(workflow.id, state);
  store.appendWal(workflow.id, {
    operationId: 'crashed-dispatch', kind: 'dispatch', state: 'pending', phase: 'SEND', sendAttempted: true,
    instructionFingerprint: 'instruction-fingerprint',
    deliverySnapshot: { agent: 'codex', threadId: 'thread-1', filePath: path.join(workflow.projectPath, 'session.jsonl'), byteOffset: 0, capturedAt: 1_000 },
  });

  const result = await loop.reconcile(workflow.id);

  assert.equal(result.autoState, 'WAITING_AGENT');
  assert.equal(verifyCalls, 1);
  assert.equal(sends(), 0);
});
