'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { handleOrchestrationRequest } = require('./http');
const { createOrchestrationRuntime } = require('./runtime');
const { createCompletionDetector } = require('./completion-detector');

function createHarness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-autopilot-e2e-'));
  const projectPath = path.join(dir, 'project');
  fs.mkdirSync(projectPath, { recursive: true });
  fs.writeFileSync(path.join(projectPath, 'PRD.md'), [
    '# 隔离多阶段项目',
    '',
    '## 产品目标',
    '- 完成一个由 AutoPilot 调度的三阶段临时项目',
    '',
    '## 阶段',
    '- 阶段一：初始化',
    '- 阶段二：实现',
    '- 阶段三：验证',
    '',
    '## DoD',
    '- 阶段一已完成',
    '- 阶段二已完成',
    '- 阶段三已完成',
    '',
    '## 测试',
    '- 隔离端到端测试通过',
  ].join('\n'), 'utf8');

  const sessionRef = 'codex:e2e-session';
  const session = {
    id: sessionRef, agent: 'codex', project: projectPath, title: 'AutoPilot E2E Session',
    session_role: 'main', control_eligibility: 'eligible',
    runtime_status: { state: 'completed', completedAt: 2_000 }, messages: [],
  };
  const sessionStore = {
    getSession: (ref) => ref === sessionRef ? session : null,
    resolveSessionControlTarget: ({ sessionRef: ref }) => ref === sessionRef
      ? {
        status: 'resolved',
        target: { sessionRef: ref, agent: 'codex', project: projectPath, role: 'main', controlEligibility: 'eligible' },
        candidates: [session], evidence: ['explicit sessionRef'],
      }
      : { status: 'not_found', target: null, candidates: [], evidence: [], reason: '指定 session 不存在' },
  };

  let sendCount = 0;
  let stage = 0;
  const transcriptPath = path.join(projectPath, 'autopilot-session.jsonl');
  fs.writeFileSync(transcriptPath, '', 'utf8');
  const dependencies = {
    resolveSession: async (request) => ({
      status: 'resolved',
      target: { sessionRef: request.sessionRef, agent: 'codex', project: projectPath, role: 'main', controlEligibility: 'eligible' },
      candidates: [session], evidence: ['isolated e2e target'],
    }),
    verifySession: async () => ({ ok: true, strongAnchor: true, anchor: 'e2e-anchor' }),
    activateSession: async () => ({ ok: true, action: 'isolated-test-activation' }),
    captureDeliverySnapshot: async () => ({
      agent: 'codex', threadId: 'e2e-thread', filePath: transcriptPath, byteOffset: fs.statSync(transcriptPath).size,
      sessionSeqBefore: sendCount, capturedAt: 2_000,
    }),
    writer: {
      write: async (_target, message) => ({ ok: true, matches: true, messageLength: message.length }),
      send: async () => {
        sendCount += 1;
        const sourceId = `autopilot-message-${sendCount}`;
        const timestamp = 2_000 + sendCount * 10;
        fs.appendFileSync(transcriptPath, JSON.stringify({ sourceId, timestamp, role: 'user', text: `autopilot turn ${sendCount}` }) + '\n', 'utf8');
        session.messages.push({ source_id: sourceId, ts: timestamp, role: 'user', text: `autopilot turn ${sendCount}` });
        return { ok: true, sourceId, timestamp };
      },
    },
    verifyDraft: async () => ({ ok: true, matches: true }),
    verifyDelivery: async () => ({
      ok: true, delivered: true, sourceId: `autopilot-message-${sendCount}`, timestamp: 2_000 + sendCount * 10,
    }),
  };
  dependencies.completionDetector = {
    detect: async () => {
      stage += 1;
      fs.writeFileSync(path.join(projectPath, 'agent-artifact.txt'), `stage-${stage}\n`, { flag: 'a' });
      return {
        status: 'completed', completed: true,
        evidence: [{ dodIndex: stage - 1, passed: true, summary: `阶段${stage}验证通过`, source: 'isolated-agent-e2e' }],
      };
    },
  };

  const runtime = createOrchestrationRuntime({
    env: { AGENT_BOARD_ALLOWED_ROOTS: dir, AGENT_BOARD_HEADLESS_EXECUTION: '0' },
    filePath: path.join(dir, 'workflows.json'),
    settingsPath: path.join(dir, 'autopilot-settings.json'),
    routingCachePath: path.join(dir, 'routing-cache.json'),
    sessionStore,
    verifiedDispatchDependencies: () => dependencies,
    autoNow: () => 2_000,
  });

  return { dir, projectPath, sessionRef, sessionStore, session, runtime, dependencies, transcriptPath, sends: () => sendCount };
}

test('AutoPilot production path creates a Session workflow, dispatches every stage, and completes with a receipt', async () => {
  const harness = createHarness();
  const { runtime, sessionRef, projectPath } = harness;
  runtime.settings.update({ autopilot: { defaultMode: 'auto', maxIterations: 8 }, routing: { enabled: false } });

  const created = await handleOrchestrationRequest({
    method: 'POST', pathname: '/api/orchestration/workflows/from-session', runtime,
    body: { sessionRef, goal: '完成一个三阶段 Web API 项目并通过测试', prdMode: 'current', confirmed: true },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.workflow.autopilotMode, 'auto');
  assert.equal(created.body.workflow.binding.sessionRef, sessionRef);
  assert.equal(created.body.workflow.binding.projectPath, projectPath);
  assert.equal(created.body.workflow.taskContract.source.fileName, 'PRD.md');
  assert.equal(created.body.workflow.taskContract.classification.kind, 'project');

  const workflowId = created.body.workflow.id;
  const accepted = await handleOrchestrationRequest({
    method: 'POST', pathname: `/api/orchestration/workflows/${workflowId}/run`, runtime, body: {},
  });
  assert.equal(accepted.status, 202);
  await accepted.background;
  assert.equal(runtime.store.get(workflowId).autoState, 'WAITING_AGENT');

  for (let i = 0; i < 3; i += 1) {
    const reconciled = await handleOrchestrationRequest({
      method: 'POST', pathname: `/api/orchestration/workflows/${workflowId}/reconcile`, runtime, body: {},
    });
    assert.equal(reconciled.status, 200);
  }

  const final = runtime.store.get(workflowId);
  assert.equal(final.autoState, 'DONE');
  assert.equal(final.status, 'completed');
  assert.equal(final.progress.status, 'completed');
  assert.equal(final.progress.completed, 3);
  assert.equal(final.observedEvidence.length, 3);
  assert.equal(final.runCount, 3);
  assert.equal(final.runReceipt.finalState, 'DONE');
  assert.equal(harness.sends(), 3);
  assert.equal(fs.readFileSync(path.join(projectPath, 'agent-artifact.txt'), 'utf8'), 'stage-1\nstage-2\nstage-3\n');
  assert.equal((await handleOrchestrationRequest({
    method: 'GET', pathname: `/api/orchestration/workflows/${workflowId}/receipt`, runtime,
  })).body.receipt.finalState, 'DONE');
  assert.ok(runtime.store.listEvents(workflowId).some((event) => event.type === 'run_receipt_created'));
  runtime.auto.stopPeriodicReconciliation();
});

test('AutoPilot pauses instead of continuing when a human adds a message after takeover dispatch', async () => {
  const harness = createHarness();
  const { runtime, sessionRef, session } = harness;
  runtime.settings.update({ autopilot: { defaultMode: 'auto' }, routing: { enabled: false } });
  const created = await handleOrchestrationRequest({
    method: 'POST', pathname: '/api/orchestration/workflows/from-session', runtime,
    body: { sessionRef, goal: '完成一个三阶段项目并通过测试', prdMode: 'current', confirmed: true },
  });
  const workflowId = created.body.workflow.id;
  const accepted = await handleOrchestrationRequest({
    method: 'POST', pathname: `/api/orchestration/workflows/${workflowId}/run`, runtime, body: {},
  });
  await accepted.background;

  session.messages.push({ source_id: 'human-message-1', ts: 2_100, role: 'user', text: '我临时改一下目标' });
  const detector = createCompletionDetector({ getSession: () => session, now: () => 2_200 });
  harness.dependencies.completionDetector = detector;
  const paused = await handleOrchestrationRequest({
    method: 'POST', pathname: `/api/orchestration/workflows/${workflowId}/reconcile`, runtime, body: {},
  });

  assert.equal(paused.status, 200);
  assert.equal(paused.body.workflow.autoState, 'PAUSED');
  assert.equal(paused.body.workflow.stopReason, 'Human Intervention');
  assert.equal(paused.body.workflow.lastError, 'HUMAN_INTERVENTION');
  assert.equal(harness.sends(), 1);
  runtime.auto.stopPeriodicReconciliation();
});
