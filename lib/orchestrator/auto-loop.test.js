'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { normalizeRunContract } = require('./run-contract');
const { WorkflowStore } = require('./workflow-store');
const { AutoLoop } = require('./auto-loop');
const { fingerprint } = require('./hosted-agent');

function setup({ dispatchResult, routingRuntime = null, verifyDeliveryFingerprint = null, reconcileEveryTurns, dod = ['测试通过'], completionDetector, bindingTitle = '', bindingTransport = '', sessionMessages = [], supervisorReview = null, evidenceCollector = null, researcher = null, handoffChain = null, sessionProvisioners = {}, budget = null, now = 2_000 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-auto-'));
  const projectPath = path.join(dir, 'app');
  const store = new WorkflowStore(path.join(dir, 'workflows.json'));
  const workflow = store.create({
    projectPath, agent: 'codex', binding: {
    sessionRef: 'session-1', agent: 'codex', projectPath,
    ...(bindingTitle ? { title: bindingTitle } : {}),
    ...(bindingTransport ? { transport: bindingTransport } : {}),
    },
    runContract: normalizeRunContract({ autopilotMode: 'auto', goal: '完成目标', verify: { dod }, ...(handoffChain ? { handoffChain } : {}), ...(budget ? { budget } : {}) }),
  });
  let sends = 0;
  const sessionRequests = [];
  const dependencies = {
    resolveSession: async (request) => {
      sessionRequests.push(request);
      return {
      status: 'resolved',
      target: { sessionRef: request.sessionRef || 'session-1', agent: request.agent, project: projectPath, role: 'main', controlEligibility: 'eligible', messages: sessionMessages },
      candidates: [{ sessionRef: request.sessionRef || 'session-1', agent: request.agent, project: projectPath, role: 'main', controlEligibility: 'eligible' }],
      messages: sessionMessages,
      };
    },
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
    completionDetector: completionDetector || { detect: async () => null },
  };
  if (dispatchResult) dependencies.dispatchResult = dispatchResult;
  if (verifyDeliveryFingerprint) dependencies.verifyDeliveryFingerprint = verifyDeliveryFingerprint;
  const loop = new AutoLoop({
    store, allowedRoots: [dir], resolveDependencies: () => dependencies, resolveCompletionDetector: () => dependencies.completionDetector,
    routingRuntime, reconcileEveryTurns, researcher,
    dispatch: async (request, injected) => {
      const result = await require('../verified-dispatch').dispatchVerifiedMessage(request, injected);
      return dependencies.dispatchResult || result;
    }, now: () => now, supervisorReview, evidenceCollector, sessionProvisioners,
  });
  return { dir, store, workflow, loop, dependencies, sessionRequests, sessionMessages, sends: () => sends };
}

test('auto loop preflight forwards the exact bound desktop session title', async () => {
  const { workflow, loop, sessionRequests } = setup({ bindingTitle: 'Visible Codex title' });
  await loop.run(workflow.id);
  assert.equal(sessionRequests[0].title, 'Visible Codex title');
});

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

test('a completed Agent reply is not killed by a stale iteration budget', async () => {
  const harness = setup({ dod: ['完成目标'], budget: { maxIterations: 1, maxRuntime: 3_600_000 } });
  await harness.loop.run(harness.workflow.id);
  assert.equal(harness.sends(), 1);
  assert.equal(harness.store.get(harness.workflow.id).runCount, 1);

  // Agent reports DONE, but no eligible evidence was recorded so calculateProgress
  // yields blocked/Budget Exceeded (runCount >= maxIterations = 1). The completion
  // must still win instead of being killed by the stale budget stop.
  harness.sessionMessages.push({
    source_id: 'agent-completed-budget', role: 'assistant', ts: 3_000,
    text: 'STATUS: COMPLETED\nDONE: 已完成目标。\nEVIDENCE: 已通过检查。',
  });

  const result = await harness.loop.reconcile(harness.workflow.id);
  assert.equal(result.autoState, 'DONE');
  assert.equal(result.runReceipt.finalState, 'DONE');
  assert.equal(harness.sends(), 1); // completion recognized, no extra turn
});

test('auto loop lets the LLM supervisor review veto an auto-completed decision', async () => {
  const harness = setup({
    supervisorReview: async () => ({
      source: 'model', provider: 'openai', model: 'gpt-x',
      review: { decision: 'NEED_HUMAN', summary: 'AI 复核认为仍需人工确认', dodChecks: [] },
    }),
  });
  await harness.loop.run(harness.workflow.id);
  harness.store.recordEvidence(harness.workflow.id, { dodIndex: 0, passed: true, summary: '测试通过', source: 'node --test' });

  const result = await harness.loop.run(harness.workflow.id);

  assert.equal(result.autoState, 'PAUSED');
  assert.equal(result.stopReason, 'Need Human');
  assert.equal(result.lastDecision.decision, 'NEED_HUMAN');
  assert.equal(result.lastDecision.reasonCode, 'AI_REVIEW_NEED_HUMAN');
});

test('a new assistant reply wakes the bound workflow and sends exactly one next turn', async () => {
  const harness = setup({ dod: ['第一项', '第二项'] });
  await harness.loop.run(harness.workflow.id);
  harness.store.recordEvidence(harness.workflow.id, { dodIndex: 0, passed: true, summary: '第一项', source: 'fake-agent' });
  harness.sessionMessages.push({
    source_id: 'agent-reply-1', role: 'assistant', ts: 3_000, text: 'STATUS: WORKING\nNEXT: 继续实现并运行测试',
  });

  const activity = await harness.loop.onSessionActivity({
    agent: 'codex', sessionRef: harness.workflow.binding.sessionRef,
    project: harness.workflow.binding.projectPath, role: 'assistant',
    messageId: fingerprint('agent-reply-1'),
  });

  assert.equal(activity.scheduled, true);
  assert.equal(harness.store.get(harness.workflow.id).runCount, 2);
  assert.equal(harness.sends(), 2);
  assert.equal(harness.store.get(harness.workflow.id).hostedControl.lastAgentMessageStatus, 'working');

  const duplicate = await harness.loop.onSessionActivity({
    agent: 'codex', sessionRef: harness.workflow.binding.sessionRef,
    project: harness.workflow.binding.projectPath, role: 'assistant',
    messageId: fingerprint('agent-reply-1'),
  });
  assert.equal(duplicate.scheduled, false);
  assert.equal(duplicate.reasonCode, 'REPLY_ALREADY_OBSERVED');
  assert.equal(harness.sends(), 2);
});

test('no new assistant reply or historical reply does not wake or resend a workflow', async () => {
  const harness = setup({
    sessionMessages: [{ source_id: 'old-agent-reply', role: 'assistant', ts: 1_000, text: '历史回复' }],
  });
  await harness.loop.run(harness.workflow.id);
  assert.equal(harness.sends(), 1);

  const unchanged = await harness.loop.reconcile(harness.workflow.id);
  assert.equal(unchanged.runCount, 1);
  assert.equal(harness.sends(), 1);

  const oldActivity = await harness.loop.onSessionActivity({
    agent: 'codex', sessionRef: harness.workflow.binding.sessionRef,
    project: harness.workflow.binding.projectPath, role: 'assistant',
    messageId: fingerprint('old-agent-reply'),
  });
  assert.equal(oldActivity.scheduled, false);
  assert.equal(oldActivity.reasonCode, 'REPLY_ALREADY_OBSERVED');
  assert.equal(harness.sends(), 1);
});

test('event-driven reconcile failures pause safely without persisting exception text', async () => {
  const harness = setup();
  await harness.loop.run(harness.workflow.id);
  harness.loop.reconcile = async () => { throw new Error('PROMPT=secret TOKEN=secret'); };

  const result = await harness.loop.onSessionActivity({
    agent: 'codex', sessionRef: harness.workflow.binding.sessionRef,
    project: harness.workflow.binding.projectPath, role: 'assistant',
    messageId: fingerprint('agent-reply-error'),
  });
  const persisted = harness.store.get(harness.workflow.id);
  assert.equal(result.scheduled, true);
  assert.equal(persisted.autoState, 'PAUSED');
  assert.equal(persisted.stopReason, 'Need Human');
  assert.equal(persisted.lastError, 'HOSTED_RECONCILE_FAILED');
  assert.doesNotMatch(JSON.stringify(persisted), /PROMPT=secret|TOKEN=secret/);
});

test('a restarted AutoLoop resumes monitoring for a persisted WAITING_AGENT workflow', async () => {
  const harness = setup({ dod: ['第一项', '第二项'] });
  await harness.loop.run(harness.workflow.id);
  harness.store.recordEvidence(harness.workflow.id, { dodIndex: 0, passed: true, summary: '第一项', source: 'fake-agent' });
  harness.sessionMessages.push({ source_id: 'agent-reply-after-restart', role: 'assistant', ts: 3_000, text: 'STATUS: WORKING\nNEXT: 继续执行' });

  const restarted = new AutoLoop({
    store: harness.store, allowedRoots: [harness.dir], resolveDependencies: () => harness.dependencies,
    resolveCompletionDetector: () => harness.dependencies.completionDetector,
    dispatch: harness.loop.dispatch, now: () => 2_000,
  });
  await restarted.reconcileAll();

  assert.equal(harness.store.get(harness.workflow.id).autoState, 'WAITING_AGENT');
  assert.equal(harness.store.get(harness.workflow.id).runCount, 2);
  assert.equal(harness.sends(), 2);
});

test('assistant activity for another Agent, Session, or project never wakes this workflow', async () => {
  const harness = setup();
  await harness.loop.run(harness.workflow.id);
  for (const activity of [
    { agent: 'claude', sessionRef: harness.workflow.binding.sessionRef, project: harness.workflow.binding.projectPath },
    { agent: 'codex', sessionRef: 'other-session', project: harness.workflow.binding.projectPath },
    { agent: 'codex', sessionRef: harness.workflow.binding.sessionRef, project: path.join(harness.dir, 'other') },
  ]) {
    const result = await harness.loop.onSessionActivity({ ...activity, role: 'assistant', messageId: fingerprint('unrelated') });
    assert.equal(result.scheduled, false);
    assert.equal(result.reasonCode, 'TARGET_NOT_FOUND');
  }
  assert.equal(harness.sends(), 1);
  assert.equal(harness.store.get(harness.workflow.id).autoState, 'WAITING_AGENT');
});

test('ambiguous assistant activity pauses every matching workflow instead of choosing one', async () => {
  const harness = setup();
  harness.store.create({
    projectPath: harness.workflow.projectPath, agent: 'codex', autopilotMode: 'auto',
    binding: { ...harness.workflow.binding }, runContract: harness.workflow.runContract,
  });

  const result = await harness.loop.onSessionActivity({
    agent: 'codex', sessionRef: harness.workflow.binding.sessionRef,
    project: harness.workflow.binding.projectPath, role: 'assistant', messageId: fingerprint('ambiguous'),
  });

  assert.equal(result.scheduled, false);
  assert.equal(result.reasonCode, 'TARGET_NOT_UNIQUE');
  assert.equal(harness.store.list().filter((workflow) => workflow.lastError === 'TARGET_NOT_UNIQUE').length, 2);
  assert.equal(harness.store.list().every((workflow) => workflow.autoState === 'PAUSED'), true);
  assert.equal(harness.sends(), 0);
});

test('periodic reconciliation errors are persisted as a safe pause instead of disappearing', async () => {
  const harness = setup();
  harness.loop.reconcile = async () => { throw new Error('secret prompt and token'); };

  await harness.loop.reconcileAll();

  const persisted = harness.store.get(harness.workflow.id);
  assert.equal(persisted.autoState, 'PAUSED');
  assert.equal(persisted.stopReason, 'Need Human');
  assert.equal(persisted.lastError, 'AUTOPILOT_TIMER_FAILED');
  assert.doesNotMatch(JSON.stringify(persisted), /secret prompt|token/);
});

test('legacy invalid permission snapshots do not crash active monitoring failure persistence', async () => {
  const harness = setup();
  const stored = harness.store.data.workflows.find((item) => item.id === harness.workflow.id);
  stored.permissionSnapshot = { invalid: true };
  stored.autoState = 'WAITING_AGENT';
  stored.status = 'running';

  await assert.doesNotReject(() => harness.loop.recordMonitoringFailureForActive('AUTOPILOT_STARTUP_FAILED'));

  const persisted = harness.store.get(harness.workflow.id);
  assert.equal(persisted.autoState, 'PAUSED');
  assert.equal(persisted.stopReason, 'Need Human');
  assert.equal(persisted.lastError, 'AUTOPILOT_STARTUP_FAILED');
  assert.deepEqual(persisted.permissionSnapshot, { invalid: true });
});

test('auto loop keeps deterministic continuation when AI Supervisor incorrectly says DONE', async () => {
  const harness = setup({ supervisorReview: async () => ({
    source: 'model', provider: 'zai', model: 'glm-test',
    review: { decision: 'DONE', summary: '误判完成', dodChecks: [] },
  }) });
  const result = await harness.loop.run(harness.workflow.id);
  assert.equal(result.autoState, 'WAITING_AGENT');
  assert.equal(result.lastDecision.decision, 'CONTINUE');
  assert.equal(result.lastDecision.review.decision, 'DONE');
  assert.equal(harness.sends(), 1);
});

test('auto loop sends a verification follow-up when AI Supervisor disputes completion', async () => {
  const harness = setup({ supervisorReview: async ({ decision }) => ({
    source: 'model', provider: 'zai', model: 'glm-test',
    review: { decision: decision.decision === 'DONE' ? 'CONTINUE' : 'CONTINUE', summary: '请补证据', dodChecks: [] },
  }) });
  await harness.loop.run(harness.workflow.id);
  harness.store.recordEvidence(harness.workflow.id, { dodIndex: 0, passed: true, summary: '测试通过', source: 'node --test' });
  const result = await harness.loop.run(harness.workflow.id);
  assert.equal(result.autoState, 'WAITING_AGENT');
  assert.equal(result.runCount, 2);
  assert.equal(result.lastDecision.reasonCode, 'AI_REVIEW_REQUESTED_VERIFICATION');
  assert.equal(harness.sends(), 2);
});

test('auto loop stores collected project evidence before completion review', async () => {
  const calls = [];
  const harness = setup({ evidenceCollector: async ({ workflow }) => {
    calls.push(workflow.runCount);
    return {
      version: 1, collectedAt: 2_000,
      checks: [{ kind: 'git', operation: 'status', command: 'git status --short', status: 'pass', exitCode: 0, output: 'clean' }],
      skipped: [],
    };
  } });
  await harness.loop.run(harness.workflow.id);
  const result = await harness.loop.reconcile(harness.workflow.id);
  assert.deepEqual(calls, [1]);
  assert.equal(result.lastEvidence.checks[0].operation, 'status');
});

test('auto loop records completion evidence and schedules the next turn automatically', async () => {
  let detectionCount = 0;
  const { store, workflow, loop, sends } = setup({
    dod: ['测试通过', '部署完成'],
    completionDetector: {
      detect: async () => {
        detectionCount += 1;
        return {
          status: 'completed',
          completed: true,
          evidence: [{ dodIndex: 0, passed: true, summary: '测试通过', source: 'completion-detector' }],
        };
      },
    },
  });

  await loop.run(workflow.id);
  const result = await loop.reconcile(workflow.id);

  assert.equal(detectionCount, 1);
  assert.equal(store.get(workflow.id).observedEvidence[0].source, 'completion-detector');
  assert.equal(result.runCount, 2);
  assert.equal(result.autoState, 'WAITING_AGENT');
  assert.equal(sends(), 2);
});

test('auto loop pauses for permission waits instead of approving or polling forever', async () => {
  const { workflow, loop, sends } = setup({
    completionDetector: {
      detect: async () => ({ status: 'waiting_user', completed: false, reasonCode: 'PERMISSION_REQUIRED' }),
    },
  });

  await loop.run(workflow.id);
  const result = await loop.reconcile(workflow.id);

  assert.equal(result.autoState, 'PAUSED');
  assert.equal(result.stopReason, 'Need Human');
  assert.equal(result.lastError, 'PERMISSION_REQUIRED');
  assert.equal(sends(), 1);
});

test('auto loop performs a safe periodic reconciliation at the configured turn boundary', async () => {
  const { store, workflow, loop } = setup({ reconcileEveryTurns: 1 });

  const result = await loop.run(workflow.id);

  assert.equal(result.autoState, 'WAITING_AGENT');
  assert.equal(result.lastReconciledRunCount, 1);
  assert.equal(result.lastReconciliation.ok, true);
  assert.deepEqual(result.lastReconciliation.checks.map((check) => check.name), [
    'goal', 'scope', 'dod', 'session_binding', 'actual_conversation', 'current_profile', 'model_catalog_version', 'progress',
  ]);
  assert.equal(store.listPendingWal(workflow.id).length, 0);
});

test('auto loop fails closed when the session is not bound or verified', async () => {
  const { store, workflow, loop, sends } = setup();
  store.updateFields(workflow.id, { binding: null }, 'test_unbound');
  const result = await loop.run(workflow.id);
  assert.equal(result.autoState, 'PAUSED');
  assert.equal(result.stopReason, 'Identity Unverified');
  assert.equal(sends(), 0);
});

test('auto loop uses the native transport for the first turn of a newly provisioned Codex session', async () => {
  const harness = setup({ bindingTransport: 'codex-app-server' });
  const nativeCalls = [];
  harness.dependencies.nativeDispatch = async (request) => {
    nativeCalls.push(request);
    return {
      ok: true,
      status: 'committed',
      phase: 'COMMIT',
      phases: [{ phase: 'SEND', status: 'ok' }],
      evidence: {
        VERIFY_SESSION: { verified: true, strongAnchor: true, source: 'app-server' },
        VERIFY_DELIVERY: { verified: true, delivered: true, source: 'app-server' },
      },
    };
  };

  const result = await harness.loop.run(harness.workflow.id);

  assert.equal(result.autoState, 'WAITING_AGENT');
  assert.equal(nativeCalls.length, 1);
  assert.equal(nativeCalls[0].sessionRef, 'session-1');
  assert.equal(harness.sessionRequests.length, 0);
  assert.equal(harness.sends(), 0);
});

test('auto loop keeps the Codex app-server transport and forwards prior replies on later turns', async () => {
  const supervisorInputs = [];
  const harness = setup({
    bindingTransport: 'codex-app-server',
    dod: ['第一轮完成', '第二轮完成'],
    supervisorReview: async (input) => {
      supervisorInputs.push(input);
      return {
        source: 'model', provider: 'test', model: 'test-model',
        review: { decision: 'CONTINUE', summary: '继续', dodChecks: [] },
      };
    },
  });
  const nativeCalls = [];
  harness.dependencies.readSession = async () => ({ messages: harness.sessionMessages.map((message) => ({ ...message })) });
  harness.dependencies.nativeDispatch = async (request) => {
    nativeCalls.push(request);
    harness.sessionMessages.push({
      source_id: `native-reply-${nativeCalls.length}`, role: 'assistant', ts: 3_000 + nativeCalls.length,
      text: `STATUS: WORKING\nDONE: 第${nativeCalls.length}轮\nNEXT: 继续`,
    });
    return {
      ok: true, status: 'committed', phase: 'COMMIT',
      phases: [{ phase: 'SEND', status: 'ok' }],
      evidence: {
        VERIFY_SESSION: { verified: true, strongAnchor: true, source: 'app-server' },
        VERIFY_DELIVERY: { verified: true, delivered: true, source: 'app-server' },
      },
    };
  };

  await harness.loop.run(harness.workflow.id);
  harness.store.recordEvidence(harness.workflow.id, { dodIndex: 0, passed: true, summary: '第一轮完成', source: 'fake-agent' });
  await harness.loop.run(harness.workflow.id);

  assert.equal(nativeCalls.length, 2);
  assert.equal(harness.sends(), 0);
  assert.equal(supervisorInputs.length, 2);
  assert.equal(supervisorInputs[1].session.messages.at(-1).text, 'STATUS: WORKING\nDONE: 第1轮\nNEXT: 继续');
});

test('auto loop pauses before the first dispatch when a human adds a message', async () => {
  const harness = setup();
  harness.sessionMessages.push({ role: 'user', ts: harness.workflow.createdAt + 1, text: '我先手动补充一条指令' });

  const result = await harness.loop.run(harness.workflow.id);

  assert.equal(result.autoState, 'PAUSED');
  assert.equal(result.controlOwner, null);
  assert.equal(result.stopReason, 'Human Intervention');
  assert.equal(result.lastError, 'HUMAN_INTERVENTION');
  assert.equal(harness.sends(), 0);
  assert.equal(harness.store.listDispatchRecords(harness.workflow.id).length, 0);
});

test('auto loop honors a human takeover that arrives during asynchronous preflight', async () => {
  const { store, workflow, loop, dependencies, sends } = setup();
  let entered;
  const preflightEntered = new Promise((resolve) => { entered = resolve; });
  let release;
  const releasePreflight = new Promise((resolve) => { release = resolve; });
  dependencies.resolveSession = async () => {
    entered();
    await releasePreflight;
    return {
      status: 'resolved',
      target: { sessionRef: 'session-1', agent: 'codex', project: workflow.projectPath, role: 'main', controlEligibility: 'eligible' },
      candidates: [{ sessionRef: 'session-1', agent: 'codex', project: workflow.projectPath, role: 'main', controlEligibility: 'eligible' }],
    };
  };

  const running = loop.run(workflow.id);
  await preflightEntered;
  store.takeover(workflow.id, 'human');
  release();
  const result = await running;

  assert.equal(result.autoState, 'PAUSED');
  assert.equal(result.controlOwner, 'human');
  assert.equal(sends(), 0);
});

test('auto loop rechecks human ownership immediately before dispatch', async () => {
  const { store, workflow, loop, dependencies, sends } = setup();
  let takenOver = false;
  dependencies.captureDeliverySnapshot = async () => {
    if (!takenOver) {
      takenOver = true;
      store.takeover(workflow.id, 'human');
    }
    return {
      agent: 'codex', threadId: 'thread-1', filePath: path.join(workflow.projectPath, 'session.jsonl'),
      byteOffset: 0, sessionSeqBefore: 4, capturedAt: 1_000,
    };
  };

  const result = await loop.run(workflow.id);

  assert.equal(result.autoState, 'PAUSED');
  assert.equal(result.controlOwner, 'human');
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

test('handoffChain executes only the current step and unlocks the dependent step after DONE', async () => {
  const harness = setup({ handoffChain: [
    { id: 'implement', order: 1, agent: 'codex', goal: '实现修复', dod: ['实现完成'], evidence: ['测试'], dependsOn: [] },
    { id: 'review', order: 2, agent: 'claude', goal: '审核修复', dod: ['审核通过'], evidence: ['审核'], dependsOn: ['implement'], sessionRef: 'claude:session-2' },
  ] });

  let result = await harness.loop.run(harness.workflow.id);
  assert.equal(result.handoffChain[0].status, 'waiting_agent');
  assert.equal(result.handoffChain[1].status, 'pending');
  assert.equal(harness.sends(), 1);

  harness.store.updateHandoffStep(harness.workflow.id, 'implement', {
    status: 'done', completedAt: 2_000, result: { summary: '实现完成' }, evidenceSnapshot: { verified: true, completed: true },
  });
  result = await harness.loop.run(harness.workflow.id);
  assert.equal(result.handoffChain[1].status, 'waiting_agent');
  assert.equal(result.handoffChain[1].agent, 'claude');
  assert.equal(harness.sends(), 2);
});

test('handoffChain researches a step before creating its session or dispatching it', async () => {
  let researchCalls = 0;
  const harness = setup({
    researcher: {
      research: async ({ goal, fields }) => {
        researchCalls += 1;
        assert.equal(goal, '研究后执行');
        assert.ok(fields.includes('dod'));
        return {
          status: 'completed', confidence: 0.9, confidenceLevel: 'high',
          sources: [{ kind: 'local', path: 'README.md', title: 'README' }],
          findings: { dod: ['测试通过'] }, unresolvedQuestions: [],
        };
      },
    },
    handoffChain: [{
      id: 'research', order: 1, agent: 'codex', goal: '研究后执行', dod: ['测试通过'], evidence: ['node --test'],
      dependsOn: [], researchState: { status: 'required' },
    }],
  });
  const result = await harness.loop.run(harness.workflow.id);
  assert.equal(researchCalls, 1);
  assert.equal(result.handoffChain[0].researchState.status, 'completed');
  assert.equal(result.handoffChain[0].status, 'waiting_agent');
  assert.equal(harness.sends(), 1);
});

test('single-agent workflow researches a pending Task Contract before its first dispatch', async () => {
  let researchCalls = 0;
  const harness = setup({
    researcher: {
      research: async () => {
        researchCalls += 1;
        return {
          status: 'completed', confidence: 0.9, confidenceLevel: 'high',
          sources: [{ kind: 'local', path: 'README.md', title: 'README' }],
          findings: { inScope: ['本地入口'], dod: ['测试通过'], evidence: ['node --test'] }, unresolvedQuestions: [],
        };
      },
    },
  });
  const taskContract = require('./task-intake').buildTaskContract({ goal: '完成目标但不说明要改什么或如何验收。', autoGenerate: true });
  harness.store.updateFields(harness.workflow.id, { taskContract, researchState: taskContract.research }, 'test_research_required');
  const result = await harness.loop.run(harness.workflow.id);
  assert.equal(researchCalls, 1);
  assert.equal(result.researchState.status, 'completed');
  assert.equal(result.taskContract.generationStatus, 'ready');
  assert.equal(harness.sends(), 1);
});

test('single-agent research timeout is terminal and never dispatches', async () => {
  const harness = setup({
    researcher: {
      research: async () => ({
        status: 'timeout', confidence: 0, errorCode: 'RESEARCH_TIMEOUT',
        needsHumanReason: '只读研究超过单步时间预算',
      }),
    },
  });
  const taskContract = require('./task-intake').buildTaskContract({ goal: '完成目标但不说明要改什么或如何验收。', autoGenerate: true });
  harness.store.updateFields(harness.workflow.id, { taskContract, researchState: taskContract.research }, 'test_research_timeout');

  const result = await harness.loop.run(harness.workflow.id);

  assert.equal(result.autoState, 'STOPPED');
  assert.equal(result.stopReason, 'Budget Exceeded');
  assert.equal(result.lastError, 'RESEARCH_TIMEOUT');
  assert.equal(harness.sends(), 0);
});

test('hosted AutoLoop answers an ordinary Agent question on the same task and does not resend it repeatedly', async () => {
  const harness = setup({
    sessionMessages: [{ source_id: 'agent-question-1', role: 'assistant', ts: 2_100, text: '页面需要选择两种布局，你希望哪一种？' }],
    completionDetector: { detect: async () => ({ status: 'waiting_user', completed: false, reasonCode: 'PERMISSION_REQUIRED' }) },
  });

  await harness.loop.run(harness.workflow.id);
  const continued = await harness.loop.reconcile(harness.workflow.id);
  const stable = await harness.loop.reconcile(harness.workflow.id);

  assert.equal(continued.autoState, 'WAITING_AGENT');
  assert.equal(continued.stopReason, null);
  assert.equal(continued.binding.sessionRef, harness.workflow.binding.sessionRef);
  assert.equal(harness.sends(), 2);
  assert.equal(stable.autoState, 'WAITING_AGENT');
  assert.equal(harness.sends(), 2);
  assert.match(continued.hostedControl.lastAgentMessageId, /^[a-f0-9]{32}$/);
  assert.equal(continued.hostedControl.lastAgentMessageStatus, 'question');
});

test('hosted AutoLoop pauses on WAITING_FOR_HOST instead of bypassing the host decision', async () => {
  const harness = setup({
    sessionMessages: [{ source_id: 'agent-waiting-for-host', role: 'assistant', ts: 2_100, text: 'STATUS: WAITING_FOR_HOST\nBLOCKED: 需要人工确认外部操作' }],
  });

  const result = await harness.loop.run(harness.workflow.id);

  assert.equal(result.autoState, 'PAUSED');
  assert.equal(result.stopReason, 'Need Human');
  assert.equal(result.lastError, 'HOST_DECISION_REQUIRED');
  assert.equal(result.hostedControl.lastAgentMessageStatus, 'waiting_for_host');
  assert.equal(harness.sends(), 0);
});

test('hosted AutoLoop accepts a current reply written before dispatch completion', async () => {
  const harness = setup();
  await harness.loop.run(harness.workflow.id);
  const dispatchRecord = harness.store.data.dispatchRecords.find((record) => record.workflowId === harness.workflow.id);
  dispatchRecord.startedAt = 1_000;
  dispatchRecord.completedAt = 2_000;
  harness.sessionMessages.push({
    source_id: 'agent-waiting-before-commit', role: 'assistant', ts: 1_900,
    text: 'STATUS: WAITING_FOR_HOST\nBLOCKED: 需要人工确认外部操作',
  });

  const result = await harness.loop.reconcile(harness.workflow.id);

  assert.equal(result.autoState, 'PAUSED');
  assert.equal(result.lastError, 'HOST_DECISION_REQUIRED');
  assert.equal(result.hostedControl.lastAgentMessageStatus, 'waiting_for_host');
  assert.equal(harness.sends(), 1);
});

test('hosted AutoLoop fails closed when the dispatch start boundary is unavailable', async () => {
  const harness = setup();
  await harness.loop.run(harness.workflow.id);
  const dispatchRecord = harness.store.data.dispatchRecords.find((record) => record.workflowId === harness.workflow.id);
  dispatchRecord.startedAt = null;
  dispatchRecord.completedAt = 2_000;
  harness.sessionMessages.push({
    source_id: 'historical-waiting-without-boundary', role: 'assistant', ts: 1_900,
    text: 'STATUS: WAITING_FOR_HOST\nBLOCKED: 需要人工确认外部操作',
  });

  const result = await harness.loop.reconcile(harness.workflow.id);

  assert.equal(result.autoState, 'WAITING_AGENT');
  assert.equal(result.hostedControl.lastAgentMessageId, '');
  assert.equal(harness.sends(), 1);
});

test('hosted AutoLoop does not finish when the latest Agent reply still asks for confirmation', async () => {
  const harness = setup({
    sessionMessages: [{ source_id: 'agent-question-2', role: 'assistant', ts: 2_100, text: '实现已经完成，请确认是否需要打开可视化草图页面？' }],
    completionDetector: { detect: async () => ({ status: 'completed', completed: true, reasonCode: 'TURN_COMPLETED' }) },
  });
  harness.store.recordEvidence(harness.workflow.id, { dodIndex: 0, passed: true, summary: '测试通过', source: 'node --test' });

  const result = await harness.loop.reconcile(harness.workflow.id);

  assert.notEqual(result.autoState, 'DONE');
  assert.equal(result.autoState, 'WAITING_AGENT');
  assert.equal(harness.sends(), 1);
});

test('hosted AutoLoop auto-completes an agent self-declared BLOCKED that actually finished the task', async () => {
  const harness = setup({ dod: ['第一项'] });
  await harness.loop.run(harness.workflow.id);
  assert.equal(harness.sends(), 1);

  // Agent 自报 STATUS: BLOCKED，但无真实边界词、且回复带 DONE 完成证据（仅因换行符差异误报）。
  harness.sessionMessages.push({
    source_id: 'agent-blocked-pedantic', role: 'assistant', ts: 3_000,
    text: 'STATUS: BLOCKED\nDONE: 已在当前目录创建并保留全部交付文件。\nBLOCKED: 仅因换行符差异。',
  });

  const result = await harness.loop.onSessionActivity({
    agent: 'codex', sessionRef: harness.workflow.binding.sessionRef,
    project: harness.workflow.binding.projectPath, role: 'assistant',
    messageId: fingerprint('agent-blocked-pedantic'),
  });

  // 误报 BLOCKED 但实际完成 → P0-B 自动收尾到 DONE，而非重复指令卡死/假暂停。
  assert.equal(result.scheduled, true);
  const wf = harness.store.get(harness.workflow.id);
  assert.equal(wf.hostedControl.lastAgentMessageStatus, 'completed');
  assert.equal(wf.autoState, 'DONE');
  assert.equal(wf.runReceipt.finalState, 'DONE');
});

test('handoffChain provisions a next Agent session only when the step has no bound session', async () => {
  let created = 0;
  const harness = setup({ handoffChain: [
    { id: 'build', order: 1, agent: 'codex', goal: '构建', dod: ['完成'], dependsOn: [] },
    { id: 'review', order: 2, agent: 'claude', goal: '审核', dod: ['通过'], dependsOn: ['build'] },
  ], sessionProvisioners: {
    claude: {
      supported: true,
      create: async () => { created += 1; return { agent: 'claude', sessionRef: 'claude:created-review' }; },
    },
  } });
  await harness.loop.run(harness.workflow.id);
  harness.store.updateHandoffStep(harness.workflow.id, 'build', {
    status: 'done', completedAt: 2_000, result: { summary: '构建完成' }, evidenceSnapshot: { verified: true, completed: true },
  });
  const result = await harness.loop.run(harness.workflow.id);
  assert.equal(created, 1);
  assert.equal(result.handoffChain[1].sessionRef, 'claude:created-review');
  assert.equal(result.binding.sessionRef, 'claude:created-review');
  assert.equal(harness.sends(), 2);
});

test('handoffChain reconciliation advances only the current step and never completes the whole chain early', async () => {
  const harness = setup({
    handoffChain: [
      { id: 'build', order: 1, agent: 'codex', goal: '构建', dod: ['构建完成'], dependsOn: [] },
      { id: 'review', order: 2, agent: 'claude', goal: '审核', dod: ['审核通过'], dependsOn: ['build'], sessionRef: 'claude:session-2' },
    ],
    completionDetector: {
      detect: async () => ({
        status: 'completed', completed: true,
        evidence: [{ dodIndex: 0, passed: true, summary: '构建完成', source: 'fake-detector' }],
      }),
    },
  });

  await harness.loop.run(harness.workflow.id);
  const result = await harness.loop.reconcile(harness.workflow.id);

  assert.equal(result.autoState, 'WAITING_AGENT');
  assert.equal(result.handoffChain[0].status, 'done');
  assert.equal(result.handoffChain[1].status, 'ready');
  assert.notEqual(result.autoState, 'DONE');
});

test('handoffChain pauses when a dependency is not DONE and never skips it', async () => {
  const harness = setup({ handoffChain: [
    { id: 'implement', order: 1, agent: 'codex', goal: '实现修复', dod: ['实现完成'], evidence: ['测试'], dependsOn: [], status: 'waiting_agent' },
    { id: 'review', order: 2, agent: 'claude', goal: '审核修复', dod: ['审核通过'], evidence: ['审核'], dependsOn: ['implement'], sessionRef: 'claude:session-2' },
  ] });
  const result = await harness.loop.run(harness.workflow.id);
  assert.equal(result.handoffChain[0].status, 'waiting_agent');
  assert.equal(result.handoffChain[1].status, 'pending');
  assert.equal(harness.sends(), 1);
});

test('handoffChain NEED_HUMAN step does not resume automatically', async () => {
  const harness = setup({ handoffChain: [
    { id: 'review', order: 1, agent: 'claude', goal: '审核修复', dod: ['审核通过'], evidence: ['审核'], dependsOn: [], status: 'need_human', result: { reason: '身份不明确' } },
  ] });
  const result = await harness.loop.run(harness.workflow.id);
  assert.equal(result.autoState, 'PAUSED');
  assert.equal(result.stopReason, 'Need Human');
  assert.equal(result.lastError, 'HANDOFF_NEED_HUMAN');
  assert.equal(harness.sends(), 0);
});

test('handoffChain marks the current step paused when policy identity checks fail', async () => {
  const harness = setup({ handoffChain: [
    { id: 'step', order: 1, agent: 'codex', goal: '执行', dod: ['完成'], dependsOn: [] },
  ] });
  harness.dependencies.verifySession = undefined;

  const result = await harness.loop.run(harness.workflow.id);

  assert.equal(result.autoState, 'PAUSED');
  assert.equal(result.handoffChain[0].status, 'paused');
  assert.equal(result.lastError, 'CAPABILITY_UNAVAILABLE');
  assert.equal(harness.sends(), 0);
});

test('handoffChain enforces step timeout, retry limit, and total budget before dispatch', async () => {
  const timeout = setup({ now: 5_001, handoffChain: [
    { id: 'step', order: 1, agent: 'codex', goal: '执行', dod: ['完成'], evidence: ['测试'], dependsOn: [], status: 'waiting_agent', startedAt: 1_000 },
  ] });
  timeout.store.updateFields(timeout.workflow.id, {
    runContract: normalizeRunContract({ autopilotMode: 'auto', goal: '执行', verify: { dod: ['完成'] }, budget: { maxStepRuntime: 1_000 } }),
  }, 'test_step_timeout');
  let result = await timeout.loop.run(timeout.workflow.id);
  assert.equal(result.lastError, 'STEP_TIMEOUT');
  assert.equal(timeout.sends(), 0);

  const retries = setup({ handoffChain: [
    { id: 'step', order: 1, agent: 'codex', goal: '重试', dod: ['完成'], evidence: ['测试'], dependsOn: [], status: 'waiting_agent', attempts: 2 },
  ] });
  retries.store.updateFields(retries.workflow.id, {
    runContract: normalizeRunContract({ autopilotMode: 'auto', goal: '重试', verify: { dod: ['完成'] }, budget: { maxRetries: 1 } }),
  }, 'test_retry_limit');
  result = await retries.loop.run(retries.workflow.id);
  assert.equal(result.lastError, 'RETRY_LIMIT_EXCEEDED');
  assert.equal(retries.sends(), 0);

  const budget = setup({ handoffChain: [
    { id: 'step', order: 1, agent: 'codex', goal: '执行', dod: ['完成'], evidence: ['测试'], dependsOn: [] },
  ] });
  budget.store.updateFields(budget.workflow.id, {
    runContract: normalizeRunContract({ autopilotMode: 'auto', goal: '执行', verify: { dod: ['完成'] }, budget: { maxBudget: 1 } }),
    budgetUsed: 1,
  }, 'test_total_budget');
  result = await budget.loop.run(budget.workflow.id);
  assert.equal(result.stopReason, 'Budget Exceeded');
  assert.equal(budget.sends(), 0);
});
