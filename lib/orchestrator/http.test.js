'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { handleOrchestrationRequest } = require('./http');
const { createOrchestrationRuntime } = require('./runtime');
const { createRoutingRuntime } = require('./routing/runtime');

function setup({ routingNativeCapability = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-http-'));
  const runtime = createOrchestrationRuntime({
    env: { AGENT_BOARD_ALLOWED_ROOTS: dir, AGENT_BOARD_HEADLESS_EXECUTION: '0' },
    filePath: path.join(dir, 'workflows.json'),
    routingCachePath: path.join(dir, 'routing-cache.json'),
    routingNativeCapability,
  });
  return { dir, runtime };
}

function sessionStoreFor({ sessionRef, projectPath, agent = 'codex', title = 'Verified Session' }) {
  const session = { id: sessionRef, agent, project: projectPath, title, session_role: 'main', control_eligibility: 'eligible' };
  return {
    getSession: (ref) => ref === sessionRef ? session : null,
    resolveSessionControlTarget: ({ sessionRef: ref }) => ref === sessionRef
      ? { status: 'resolved', target: { sessionRef: ref, agent, project: projectPath, role: 'main' }, candidates: [session], evidence: ['explicit sessionRef'] }
      : { status: 'not_found', target: null, candidates: [], evidence: [], reason: '指定 session 不存在' },
  };
}

test('HTTP orchestration API creates and lists a workflow without exposing secrets', async () => {
  const { dir, runtime } = setup();
  const created = await handleOrchestrationRequest({
    method: 'POST', pathname: '/api/orchestration/workflows', runtime,
    body: {
      projectPath: path.join(dir, 'app'), goal: '初始化服务', mode: 'project', agent: 'codex',
      verify: { dod: ['测试通过'] },
    },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.classification.kind, 'new');
  const listed = await handleOrchestrationRequest({ method: 'GET', pathname: '/api/orchestration/workflows', runtime });
  assert.equal(listed.body.items.length, 1);
});

test('HTTP takeover endpoint changes the same workflow the AI monitor sees', async () => {
  const { dir, runtime } = setup();
  const created = await handleOrchestrationRequest({
    method: 'POST', pathname: '/api/orchestration/workflows', runtime,
    body: { projectPath: path.join(dir, 'app'), goal: 'x', verify: { dod: ['完成'] } },
  });
  const id = created.body.workflow.id;
  await handleOrchestrationRequest({ method: 'POST', pathname: `/api/orchestration/workflows/${id}/transition`, runtime, body: { status: 'queued' } });
  const takeover = await handleOrchestrationRequest({ method: 'POST', pathname: `/api/orchestration/workflows/${id}/takeover`, runtime, body: {} });
  assert.equal(takeover.body.workflow.controlOwner, 'human');
  assert.equal(takeover.body.workflow.status, 'paused');
  const state = await handleOrchestrationRequest({ method: 'GET', pathname: '/api/orchestration/state', runtime });
  assert.equal(state.body.workflows[0].status, 'paused');
  assert.equal(JSON.stringify(state.body).includes('API_KEY'), false);
});

test('run endpoint accepts work and keeps disabled headless execution waiting for policy', async () => {
  const { dir, runtime } = setup();
  const created = await handleOrchestrationRequest({
    method: 'POST', pathname: '/api/orchestration/workflows', runtime,
    body: { projectPath: path.join(dir, 'app'), goal: 'x', agent: 'codex', autopilotMode: 'suggest', verify: { dod: ['完成'] } },
  });
  const id = created.body.workflow.id;
  const accepted = await handleOrchestrationRequest({ method: 'POST', pathname: `/api/orchestration/workflows/${id}/run`, runtime, body: {} });
  assert.equal(accepted.status, 409);
  assert.equal(accepted.body.code, 'SUGGEST_ONLY');
  assert.equal('background' in accepted, false);
});

test('run endpoint keeps Guarded Mode behind an explicit human approval boundary', async () => {
  const { dir, runtime } = setup();
  const created = await handleOrchestrationRequest({
    method: 'POST', pathname: '/api/orchestration/workflows', runtime,
    body: { projectPath: path.join(dir, 'guarded-app'), goal: 'x', agent: 'codex', autopilotMode: 'guarded', verify: { dod: ['完成'] } },
  });
  const accepted = await handleOrchestrationRequest({ method: 'POST', pathname: `/api/orchestration/workflows/${created.body.workflow.id}/run`, runtime, body: {} });
  assert.equal(accepted.status, 409);
  assert.equal(accepted.body.code, 'GUARDED_REQUIRES_APPROVAL');
  assert.equal('background' in accepted, false);
});

test('settings endpoint persists global defaults and new workflows inherit them', async () => {
  const { dir, runtime } = setup();
  const initial = await handleOrchestrationRequest({ method: 'GET', pathname: '/api/orchestration/settings', runtime });
  assert.equal(initial.status, 200);
  assert.equal(initial.body.settings.autopilot.defaultMode, 'auto');

  const saved = await handleOrchestrationRequest({
    method: 'PUT', pathname: '/api/orchestration/settings', runtime,
    body: { autopilot: { defaultMode: 'suggest', maxIterations: 8 }, routing: { enabled: false } },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.settings.autopilot.maxIterations, 8);

  const created = await handleOrchestrationRequest({
    method: 'POST', pathname: '/api/orchestration/workflows', runtime,
    body: { projectPath: path.join(dir, 'inherited-app'), goal: 'inherit', agent: 'codex', verify: { dod: ['完成'] } },
  });
  assert.equal(created.body.workflow.autopilotMode, 'suggest');
  assert.equal(created.body.workflow.runContract.budget.maxIterations, 8);
  assert.equal(created.body.workflow.routingConfig.enabled, false);
  assert.equal(created.body.workflow.settingsSnapshot.routing.enabled, false);
});

test('session fast path derives the binding from the current session and ignores client metadata', async () => {
  const { dir, runtime } = setup();
  const sessionRef = 'codex:current-session';
  const session = {
    id: sessionRef,
    agent: 'codex',
    project: path.join(dir, 'current-project'),
    title: '当前项目任务',
    session_role: 'main',
    control_eligibility: 'eligible',
  };
  runtime.sessionStore = {
    getSession: (ref) => ref === sessionRef ? session : null,
    resolveSessionControlTarget: ({ sessionRef: ref }) => ref === sessionRef
      ? { status: 'resolved', target: { sessionRef: ref, role: 'main' }, candidates: [session], evidence: ['explicit sessionRef'] }
      : { status: 'not_found', target: null, candidates: [], evidence: [], reason: '指定 session 不存在' },
  };

  const created = await handleOrchestrationRequest({
    method: 'POST', pathname: '/api/orchestration/workflows/from-session', runtime,
    body: {
      sessionRef, goal: '修复当前项目测试', agent: 'claude', projectPath: path.join(dir, 'wrong-project'),
      mode: 'global', autopilotMode: 'suggest', verify: { dod: ['客户端不应控制此字段'] }, confirmed: true,
    },
  });

  assert.equal(created.status, 201);
  assert.equal(created.body.workflow.agent, 'codex');
  assert.equal(created.body.workflow.projectPath, path.join(dir, 'current-project'));
  assert.equal(created.body.workflow.mode, 'project');
  assert.equal(created.body.workflow.autopilotMode, 'auto');
  assert.deepEqual(created.body.workflow.binding, {
    sessionRef, agent: 'codex', projectPath: path.join(dir, 'current-project'), title: '当前项目任务',
  });
  assert.deepEqual(created.body.workflow.runContract.verify.dod, created.body.taskContract.dod);
});

test('session fast path creates a paused Workflow for low-confidence contracts', async () => {
  const { dir, runtime } = setup();
  const projectPath = path.join(dir, 'low-confidence-project');
  fs.mkdirSync(projectPath);
  const sessionRef = 'codex:low-confidence-session';
  runtime.sessionStore = sessionStoreFor({ sessionRef, projectPath });

  const result = await handleOrchestrationRequest({
    method: 'POST', pathname: '/api/orchestration/workflows/from-session', runtime,
    body: { sessionRef, goal: '完成目标', prdMode: 'none', confirmed: true },
  });

  assert.equal(result.status, 202);
  assert.equal(result.body.requiresApproval, true);
  assert.equal(result.body.workflow.status, 'paused');
  assert.ok(result.body.workflow.stopReason);
  assert.equal(runtime.store.list().length, 1);
});

test('session fast path refuses an unresolved session instead of guessing another project', async () => {
  const { runtime } = setup();
  runtime.sessionStore = {
    getSession: () => null,
    resolveSessionControlTarget: () => ({ status: 'ambiguous', target: null, candidates: [], evidence: [], reason: '匹配到多个主会话' }),
  };
  const response = await handleOrchestrationRequest({
    method: 'POST', pathname: '/api/orchestration/workflows/from-session', runtime,
    body: { sessionRef: 'codex:ambiguous', goal: '不应执行', confirmed: true },
  });
  assert.equal(response.status, 409);
  assert.equal(response.body.code, 'SESSION_TARGET_UNRESOLVED');
  assert.equal(runtime.store.list().length, 0);
});

test('PRD draft endpoint reads only the resolved current Session project and creates no workflow', async () => {
  const { dir, runtime } = setup();
  const projectPath = path.join(dir, 'prd-project');
  fs.mkdirSync(projectPath);
  fs.writeFileSync(path.join(projectPath, 'PRD.md'), '# 托管目标\n\n只允许用户确认后启动。\n\n## DoD\n- 目标可验证\n', 'utf8');
  const sessionRef = 'codex:prd-session';
  runtime.sessionStore = {
    getSession: (ref) => ref === sessionRef ? { id: ref, agent: 'codex', project: projectPath } : null,
    resolveSessionControlTarget: ({ sessionRef: ref }) => ref === sessionRef
      ? { status: 'resolved', target: { sessionRef: ref }, candidates: [], evidence: ['explicit sessionRef'] }
      : { status: 'not_found', target: null, candidates: [], evidence: [] },
  };

  const result = await handleOrchestrationRequest({
    method: 'POST', pathname: '/api/orchestration/prd-draft', runtime,
    body: { sessionRef, projectPath: path.join(dir, 'wrong-project') },
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.sessionRef, sessionRef);
  assert.equal(result.body.source, 'local-extraction');
  assert.match(result.body.draft.goal, /托管目标/);
  assert.deepEqual(result.body.draft.dod, ['目标可验证']);
  assert.equal(runtime.store.list().length, 0);
});

test('PRD candidates resolve the project from Session and return metadata without content', async () => {
  const { dir, runtime } = setup();
  const projectPath = path.join(dir, 'candidate-project');
  fs.mkdirSync(projectPath);
  fs.writeFileSync(path.join(projectPath, 'PRD.md'), '# Candidate\n\nVersion: v1.0\n', 'utf8');
  const sessionRef = 'codex:candidate-session';
  runtime.sessionStore = sessionStoreFor({ sessionRef, projectPath });

  const result = await handleOrchestrationRequest({
    method: 'GET', pathname: '/api/orchestration/prd/candidates', runtime,
    query: new URLSearchParams({ sessionRef, projectPath: path.join(dir, 'wrong-project') }),
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.items.length, 1);
  assert.equal(result.body.items[0].name, 'PRD.md');
  assert.equal(result.body.items[0].version, 'v1.0');
  assert.equal(JSON.stringify(result.body).includes('# Candidate'), false);
  assert.equal(runtime.store.list().length, 0);
});

test('PRD candidates return a stable error code for a project outside allowed roots', async () => {
  const { runtime } = setup();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-prd-api-outside-'));

  const result = await handleOrchestrationRequest({
    method: 'GET', pathname: '/api/orchestration/prd/candidates', runtime,
    query: new URLSearchParams({ projectPath: outside }),
  });

  assert.equal(result.status, 403);
  assert.equal(result.body.code, 'PROJECT_OUTSIDE_ALLOWED_ROOTS');
});

test('Task Intake preview re-resolves Session and never creates or dispatches a workflow', async () => {
  const { dir, runtime } = setup();
  const projectPath = path.join(dir, 'preview-project');
  fs.mkdirSync(projectPath);
  const sessionRef = 'codex:preview-session';
  runtime.sessionStore = sessionStoreFor({ sessionRef, projectPath });
  let dispatched = false;
  runtime.auto = { run: async () => { dispatched = true; } };

  const result = await handleOrchestrationRequest({
    method: 'POST', pathname: '/api/orchestration/intake/preview', runtime,
    body: { sessionRef, goal: '修复登录 API 并补充单元测试', projectPath: path.join(dir, 'wrong'), agent: 'claude' },
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.taskContract.classification.kind, 'standard');
  assert.equal(result.body.warning, '本合同仅根据任务目标生成，未读取 PRD。');
  assert.equal(result.body.analysis.noPrd, true);
  assert.deepEqual(result.body.session, { sessionRef, agent: 'codex', projectPath, title: 'Verified Session' });
  assert.equal(result.body.taskContract.runtimeContext.projectPathSource, 'session');
  assert.equal(runtime.store.list().length, 0);
  assert.equal(dispatched, false);
});

test('Task Intake preview derives a missing goal from the current Session message', async () => {
  const { dir, runtime } = setup();
  const projectPath = path.join(dir, 'goal-fallback-project');
  fs.mkdirSync(projectPath);
  const sessionRef = 'codex:goal-fallback';
  const session = {
    id: sessionRef, agent: 'codex', project: projectPath, title: '未完成标题',
    last_user_text: '请修复当前项目的登录测试并给出验证结果', session_role: 'main', control_eligibility: 'eligible',
  };
  runtime.sessionStore = {
    getSession: (ref) => ref === sessionRef ? session : null,
    resolveSessionControlTarget: ({ sessionRef: ref }) => ref === sessionRef
      ? { status: 'resolved', target: { sessionRef: ref }, candidates: [session], evidence: ['explicit sessionRef'] }
      : { status: 'not_found', target: null, candidates: [], evidence: [] },
  };
  const result = await handleOrchestrationRequest({
    method: 'POST', pathname: '/api/orchestration/intake/preview', runtime,
    body: { sessionRef, prdMode: 'none' },
  });
  assert.equal(result.status, 200);
  assert.match(result.body.taskContract.goal, /修复当前项目的登录测试/);
  assert.equal(runtime.store.list().length, 0);
});

test('Task Intake requires explicit selection when multiple high-confidence PRDs exist', async () => {
  const { dir, runtime } = setup();
  const projectPath = path.join(dir, 'multi-prd');
  fs.mkdirSync(projectPath);
  fs.writeFileSync(path.join(projectPath, 'Product_PRD_v1.0.md'), '# V1\n', 'utf8');
  fs.writeFileSync(path.join(projectPath, 'Product_PRD_v1.1.md'), '# V2\n', 'utf8');
  const sessionRef = 'codex:multi-prd';
  runtime.sessionStore = sessionStoreFor({ sessionRef, projectPath });

  const result = await handleOrchestrationRequest({
    method: 'POST', pathname: '/api/orchestration/intake/preview', runtime,
    body: { sessionRef, goal: '按 PRD 完成多阶段项目', prdMode: 'current' },
  });

  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'PRD_SELECTION_REQUIRED');
  assert.equal(result.body.candidates.length, 2);
  assert.equal(runtime.store.list().length, 0);
});

test('Task Intake can read a manually selected parent PRD inside the allowed root', async () => {
  const { dir, runtime } = setup();
  const projectPath = path.join(dir, 'manual-project');
  fs.mkdirSync(projectPath);
  const prdPath = path.join(dir, 'Parent_PRD_v2.0.md');
  fs.writeFileSync(prdPath, '# Parent Project\n\n## 产品目标\n- 完成统一 Intake\n\n## DoD\n- tests pass\n', 'utf8');
  const sessionRef = 'codex:manual-prd';
  runtime.sessionStore = sessionStoreFor({ sessionRef, projectPath });

  const result = await handleOrchestrationRequest({
    method: 'POST', pathname: '/api/orchestration/intake/preview', runtime,
    body: { sessionRef, prdMode: 'manual', prdPath },
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.taskContract.classification.kind, 'project');
  assert.equal(result.body.taskContract.goal, '完成统一 Intake');
  assert.equal(result.body.taskContract.source.fileName, 'Parent_PRD_v2.0.md');
  assert.match(result.body.taskContract.source.sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.body.taskContract.source.selectedBy, 'user');
});

test('Task Intake rejects a manually selected PRD outside allowed roots', async () => {
  const { dir, runtime } = setup();
  const projectPath = path.join(dir, 'bounded-project');
  fs.mkdirSync(projectPath);
  const outside = path.join(os.tmpdir(), `outside-intake-${Date.now()}.md`);
  fs.writeFileSync(outside, '# Outside\n', 'utf8');
  const sessionRef = 'codex:bounded-prd';
  runtime.sessionStore = sessionStoreFor({ sessionRef, projectPath });

  const result = await handleOrchestrationRequest({
    method: 'POST', pathname: '/api/orchestration/intake/preview', runtime,
    body: { sessionRef, goal: '读取 PRD', prdMode: 'manual', prdPath: outside },
  });

  assert.equal(result.status, 403);
  assert.equal(result.body.code, 'PRD_PATH_OUTSIDE_ALLOWED_ROOTS');
  assert.equal(runtime.store.list().length, 0);
});

test('Session start bypasses complex Workflow creation for direct tasks', async () => {
  const { dir, runtime } = setup();
  const projectPath = path.join(dir, 'direct-project');
  fs.mkdirSync(projectPath);
  const sessionRef = 'codex:direct-session';
  runtime.sessionStore = sessionStoreFor({ sessionRef, projectPath });

  const result = await handleOrchestrationRequest({
    method: 'POST', pathname: '/api/orchestration/workflows/from-session', runtime,
    body: { sessionRef, goal: '1+1 等于多少？', prdMode: 'none', confirmed: true },
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.bypass, true);
  assert.equal(result.body.taskContract.classification.kind, 'direct');
  assert.equal(result.body.workflow, null);
  assert.equal(runtime.store.list().length, 0);
});

test('high-risk Session start snapshots the Task Contract and remains paused for human approval', async () => {
  const { dir, runtime } = setup();
  const projectPath = path.join(dir, 'risky-project');
  fs.mkdirSync(projectPath);
  const sessionRef = 'codex:risky-session';
  runtime.sessionStore = sessionStoreFor({ sessionRef, projectPath });

  const result = await handleOrchestrationRequest({
    method: 'POST', pathname: '/api/orchestration/workflows/from-session', runtime,
    body: { sessionRef, goal: '把内容真实发布到小红书并自动回复评论', prdMode: 'none', confirmed: true },
  });

  assert.equal(result.status, 202);
  assert.equal(result.body.requiresApproval, true);
  assert.equal(result.body.workflow.status, 'paused');
  assert.equal(result.body.workflow.autoState, 'PAUSED');
  assert.equal(result.body.workflow.taskContract.humanGate.required, true);
  assert.equal(JSON.stringify(result.body.workflow).includes('API_KEY'), false);
});

test('project intake works without an existing Session and creates nothing before explicit confirmation', async () => {
  const { dir, runtime } = setup();
  const projectPath = path.join(dir, 'new-task-project');
  fs.mkdirSync(projectPath);
  const calls = [];
  runtime.sessionStore = { getSessions: () => [] };
  runtime.sessionProvisioners = {
    codex: { supported: true, create: async (input) => { calls.push(input); return { sessionRef: 'codex:new-thread', agent: 'codex', projectPath: input.projectPath }; } },
  };
  runtime.auto = { run: async () => { throw new Error('preview/confirm must not auto-run'); } };

  const preview = await handleOrchestrationRequest({
    method: 'POST', pathname: '/api/orchestration/intake/preview', runtime,
    body: { agent: 'codex', projectPath, goal: '实现 API 并补充单元测试', prdMode: 'none' },
  });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.session, null);
  assert.equal(preview.body.existingSessions.length, 0);
  assert.match(preview.body.draftId, /^draft-/);
  assert.equal(runtime.store.list().length, 0);
  assert.equal(calls.length, 0);

  const notConfirmed = await handleOrchestrationRequest({
    method: 'POST', pathname: '/api/orchestration/intake/confirm', runtime,
    body: { draftId: preview.body.draftId },
  });
  assert.equal(notConfirmed.status, 409);
  assert.equal(notConfirmed.body.code, 'TASK_CONTRACT_CONFIRMATION_REQUIRED');
  assert.equal(runtime.store.list().length, 0);
  assert.equal(calls.length, 0);

  const confirmed = await handleOrchestrationRequest({
    method: 'POST', pathname: '/api/orchestration/intake/confirm', runtime,
    body: {
      draftId: preview.body.draftId, confirmed: true,
      settings: { autopilot: { defaultMode: 'guarded', defaultModel: 'gpt-test', maxBudget: 12.5 }, safety: { allowNetwork: true } },
    },
  });
  assert.equal(confirmed.status, 201);
  assert.equal(confirmed.body.created, true);
  assert.equal(confirmed.body.session.sessionRef, 'codex:new-thread');
  assert.equal(confirmed.body.workflow.binding.sessionRef, 'codex:new-thread');
  assert.equal(confirmed.body.workflow.settingsSnapshot.snapshotId.startsWith('ss-'), true);
  assert.equal(confirmed.body.workflow.permissionSnapshot.snapshotId.startsWith('ps-'), true);
  assert.equal(confirmed.body.workflow.autopilotMode, 'guarded');
  assert.equal(confirmed.body.workflow.settingsSnapshot.autopilot.defaultModel, 'gpt-test');
  assert.equal(confirmed.body.workflow.settingsSnapshot.autopilot.maxBudget, 12.5);
  assert.equal(confirmed.body.workflow.permissionSnapshot.allowNetwork, true);
  assert.equal(calls.length, 1);
});

test('duplicate Agent/project Sessions default to a new Session and can be explicitly continued', async () => {
  const { dir, runtime } = setup();
  const projectPath = path.join(dir, 'duplicate-project');
  fs.mkdirSync(projectPath);
  const existing = { id: 'codex:existing-thread', agent: 'codex', project: projectPath, title: '旧 Session', session_role: 'main', control_eligibility: 'eligible', last_seen: 10 };
  const sessions = [existing];
  const provisioned = [];
  runtime.sessionStore = {
    getSessions: () => sessions,
    getSession: (ref) => ref === existing.id ? existing : null,
    resolveSessionControlTarget: ({ sessionRef }) => sessionRef === existing.id
      ? { status: 'resolved', target: { sessionRef, agent: 'codex', project: projectPath, role: 'main' }, candidates: [existing] }
      : { status: 'not_found', target: null, candidates: [] },
  };
  runtime.sessionProvisioners = {
    codex: { supported: true, create: async ({ projectPath: cwd }) => { const session = { sessionRef: `codex:new-${provisioned.length + 1}`, agent: 'codex', projectPath: cwd }; provisioned.push(session); return session; } },
  };

  const firstPreview = await handleOrchestrationRequest({
    method: 'POST', pathname: '/api/orchestration/intake/preview', runtime,
    body: { agent: 'codex', projectPath, goal: '实现一个功能', prdMode: 'none' },
  });
  assert.equal(firstPreview.body.existingSessions[0].sessionRef, existing.id);
  const first = await handleOrchestrationRequest({
    method: 'POST', pathname: '/api/orchestration/intake/confirm', runtime,
    body: { draftId: firstPreview.body.draftId, confirmed: true },
  });
  assert.equal(first.body.sessionChoice, 'new');
  assert.equal(first.body.workflow.binding.sessionRef, 'codex:new-1');
  assert.equal(provisioned.length, 1);

  const secondPreview = await handleOrchestrationRequest({
    method: 'POST', pathname: '/api/orchestration/intake/preview', runtime,
    body: { agent: 'codex', projectPath, goal: '继续旧任务', prdMode: 'none' },
  });
  const continued = await handleOrchestrationRequest({
    method: 'POST', pathname: '/api/orchestration/intake/confirm', runtime,
    body: { draftId: secondPreview.body.draftId, confirmed: true, sessionChoice: 'continue', sessionRef: existing.id },
  });
  assert.equal(continued.status, 201);
  assert.equal(continued.body.sessionChoice, 'continue');
  assert.equal(continued.body.workflow.binding.sessionRef, existing.id);
  assert.equal(provisioned.length, 1);
});

test('suggest endpoint returns a structured suggestion without running transport', async () => {
  const { dir, runtime } = setup();
  let ran = false;
  runtime.runner = { run: async () => { ran = true; } };
  const created = await handleOrchestrationRequest({
    method: 'POST', pathname: '/api/orchestration/workflows', runtime,
    body: {
      projectPath: path.join(dir, 'app'), goal: '完成目标', agent: 'codex',
      verify: { dod: ['检查完成'] },
    },
  });
  const id = created.body.workflow.id;
  const suggestion = await handleOrchestrationRequest({
    method: 'POST', pathname: `/api/orchestration/workflows/${id}/suggest`, runtime, body: {},
  });
  assert.equal(suggestion.status, 200);
  assert.equal(suggestion.body.suggestion.action, 'suggest');
  assert.equal(suggestion.body.suggestion.turnContract.send, false);
  assert.equal(runtime.store.get(id).lastReceipt.suggestionId, suggestion.body.suggestion.suggestionId);
  assert.equal(ran, false);
});

test('confirm auto-completes omitted safe fields from the generated draft', async () => {
  const { dir, runtime } = setup();
  const projectPath = path.join(dir, 'incomplete-contract-project');
  fs.mkdirSync(projectPath);
  let provisioned = 0;
  runtime.sessionStore = { getSessions: () => [] };
  runtime.sessionProvisioners = {
    codex: { supported: true, create: async ({ projectPath: cwd }) => { provisioned++; return { sessionRef: 'codex:incomplete-completed', agent: 'codex', projectPath: cwd }; } },
  };

  const preview = await handleOrchestrationRequest({
    method: 'POST', pathname: '/api/orchestration/intake/preview', runtime,
    body: { agent: 'codex', projectPath, goal: '实现登录 API 并补充单元测试', prdMode: 'none' },
  });
  const incomplete = {
    ...preview.body.taskContract,
    outOfScope: [],
    dod: [],
    evidence: [],
    missingFields: [],
  };
  const result = await handleOrchestrationRequest({
    method: 'POST', pathname: '/api/orchestration/intake/confirm', runtime,
    body: { draftId: preview.body.draftId, confirmed: true, decision: 'confirm', taskContract: incomplete },
  });

  assert.equal(result.status, 201);
  assert.equal(result.body.created, true);
  assert.ok(result.body.session.sessionRef);
  assert.ok(result.body.taskContract.outOfScope.length > 0);
  assert.ok(result.body.taskContract.dod.length > 0);
  assert.ok(result.body.taskContract.evidence.length > 0);
  assert.equal(provisioned, 1);
  assert.equal(runtime.store.list().length, 1);
});

test('confirm creates the Session but pauses the Workflow for denied permissions', async () => {
  const { dir, runtime } = setup();
  const projectPath = path.join(dir, 'permission-contract-project');
  fs.mkdirSync(projectPath);
  let provisioned = 0;
  runtime.sessionStore = { getSessions: () => [] };
  runtime.sessionProvisioners = {
    codex: { supported: true, create: async ({ projectPath: cwd }) => { provisioned++; return { sessionRef: 'codex:permission-paused', agent: 'codex', projectPath: cwd }; } },
  };

  const preview = await handleOrchestrationRequest({
    method: 'POST', pathname: '/api/orchestration/intake/preview', runtime,
    body: { agent: 'codex', projectPath, goal: '实现本地功能并补充测试', prdMode: 'none' },
  });
  const denied = {
    ...preview.body.taskContract,
    requiredPermissions: ['访问网络'],
  };
  const result = await handleOrchestrationRequest({
    method: 'POST', pathname: '/api/orchestration/intake/confirm', runtime,
    body: { draftId: preview.body.draftId, confirmed: true, decision: 'confirm', taskContract: denied },
  });

  assert.equal(result.status, 202);
  assert.equal(result.body.created, true);
  assert.equal(result.body.session.sessionRef, 'codex:permission-paused');
  assert.equal(result.body.requiresApproval, true);
  assert.equal(result.body.workflow.status, 'paused');
  assert.match(result.body.workflow.stopReason, /权限|人工/);
  assert.equal(result.body.workflow.permissionSnapshot.allowNetwork, false);
  assert.equal(provisioned, 1);
  assert.equal(runtime.store.list().length, 1);
});

test('confirm creates a Session for a vague goal and pauses it for human clarification', async () => {
  const { dir, runtime } = setup();
  const projectPath = path.join(dir, 'vague-goal-project');
  fs.mkdirSync(projectPath);
  let provisioned = 0;
  runtime.sessionStore = { getSessions: () => [] };
  runtime.sessionProvisioners = {
    codex: { supported: true, create: async ({ projectPath: cwd }) => { provisioned++; return { sessionRef: 'codex:vague-goal', agent: 'codex', projectPath: cwd }; } },
  };

  const preview = await handleOrchestrationRequest({
    method: 'POST', pathname: '/api/orchestration/intake/preview', runtime,
    body: { agent: 'codex', projectPath, goal: '完成目标', prdMode: 'none' },
  });
  assert.equal(preview.status, 200);
  assert.ok(preview.body.taskContract.inScope.length > 0);
  assert.ok(preview.body.taskContract.dod.length > 0);
  assert.ok(preview.body.taskContract.evidence.length > 0);

  const result = await handleOrchestrationRequest({
    method: 'POST', pathname: '/api/orchestration/intake/confirm', runtime,
    body: { draftId: preview.body.draftId, confirmed: true, decision: 'confirm' },
  });
  assert.equal(result.status, 202);
  assert.equal(result.body.session.sessionRef, 'codex:vague-goal');
  assert.equal(result.body.requiresApproval, true);
  assert.equal(result.body.workflow.status, 'paused');
  assert.equal(provisioned, 1);
});

test('suggest endpoint reports human takeover without changing ownership', async () => {
  const { dir, runtime } = setup();
  const created = await handleOrchestrationRequest({
    method: 'POST', pathname: '/api/orchestration/workflows', runtime,
    body: { projectPath: path.join(dir, 'app'), goal: 'x', verify: { dod: ['完成'] } },
  });
  const id = created.body.workflow.id;
  await handleOrchestrationRequest({ method: 'POST', pathname: `/api/orchestration/workflows/${id}/takeover`, runtime, body: {} });
  const suggestion = await handleOrchestrationRequest({
    method: 'POST', pathname: `/api/orchestration/workflows/${id}/suggest`, runtime, body: {},
  });
  assert.equal(suggestion.body.suggestion.action, 'need_human');
  assert.equal(runtime.store.get(id).controlOwner, 'human');
});

test('auto run endpoint starts only a bound verified single-session loop', async () => {
  const { dir, runtime } = setup();
  const calls = [];
  runtime.auto = {
    run: async (id) => { calls.push(id); return runtime.store.get(id); },
  };
  const created = await handleOrchestrationRequest({
    method: 'POST', pathname: '/api/orchestration/workflows', runtime,
    body: {
      projectPath: path.join(dir, 'app'), goal: '自动完成', agent: 'codex', autopilotMode: 'auto',
      binding: { sessionRef: 'session-1', agent: 'codex', projectPath: path.join(dir, 'app') },
      verify: { dod: ['完成'] },
    },
  });
  const id = created.body.workflow.id;
  const accepted = await handleOrchestrationRequest({ method: 'POST', pathname: `/api/orchestration/workflows/${id}/run`, runtime, body: {} });
  assert.equal(accepted.status, 202);
  assert.equal(accepted.body.accepted, true);
  await accepted.background;
  assert.deepEqual(calls, [id]);
});

test('auto control endpoints expose evidence, reconcile, resume, and user stop', async () => {
  const { dir, runtime } = setup();
  const calls = [];
  runtime.auto = {
    reconcile: async (id) => { calls.push(['reconcile', id]); return runtime.store.get(id); },
    resume: (id) => { calls.push(['resume', id]); return runtime.store.get(id); },
    stop: (id) => { calls.push(['stop', id]); return runtime.store.get(id); },
  };
  const created = await handleOrchestrationRequest({
    method: 'POST', pathname: '/api/orchestration/workflows', runtime,
    body: { projectPath: path.join(dir, 'app'), goal: 'x', agent: 'codex', autopilotMode: 'auto',
      binding: { sessionRef: 'session-1', agent: 'codex', projectPath: path.join(dir, 'app') }, verify: { dod: ['完成'] } },
  });
  const id = created.body.workflow.id;
  const evidence = await handleOrchestrationRequest({ method: 'POST', pathname: `/api/orchestration/workflows/${id}/evidence`, runtime,
    body: { dodIndex: 0, passed: true, summary: '完成', source: 'test' } });
  assert.equal(evidence.status, 200);
  assert.equal(evidence.body.workflow.observedEvidence.length, 1);
  for (const endpoint of ['reconcile', 'resume', 'stop']) {
    const response = await handleOrchestrationRequest({ method: 'POST', pathname: `/api/orchestration/workflows/${id}/${endpoint}`, runtime, body: {} });
    assert.equal(response.status, 200);
  }
  assert.deepEqual(calls.map(([name]) => name), ['reconcile', 'resume', 'stop']);
});

test('routing catalog and per-workflow configuration APIs are Codex-only and safe', async () => {
  const { dir, runtime } = setup();
  const catalog = await handleOrchestrationRequest({ method: 'GET', pathname: '/api/orchestration/routing/catalog', runtime });
  assert.equal(catalog.status, 200);
  assert.deepEqual(catalog.body.supportedAgents, ['codex']);
  assert.equal(catalog.body.catalog.available, false);

  const created = await handleOrchestrationRequest({
    method: 'POST', pathname: '/api/orchestration/workflows', runtime,
    body: { projectPath: path.join(dir, 'app'), goal: 'route', agent: 'codex', verify: { dod: ['完成'] }, routingConfig: { enabled: true, preset: 'quality' } },
  });
  const id = created.body.workflow.id;
  const updated = await handleOrchestrationRequest({
    method: 'POST', pathname: `/api/orchestration/workflows/${id}/routing`, runtime,
    body: { config: { enabled: true, preset: 'custom', complexityTier: 'C2', thinkingTier: 'T2', prompt: 'drop me' } },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.routing.complexityTier, 'C2');
  assert.equal('prompt' in updated.body.routing, false);
  const current = await handleOrchestrationRequest({ method: 'GET', pathname: `/api/orchestration/workflows/${id}/routing`, runtime });
  assert.equal(current.body.config.thinkingTier, 'T2');
});

test('routing catalog reports prompt-only capabilities without hiding their boundary', async () => {
  const { runtime } = setup();
  runtime.routing = createRoutingRuntime({
    nativeCapability: null,
    agentCapabilities: { hermes: { supportsReasoning: false, routingMode: 'prompt-only' } },
  });

  const response = await handleOrchestrationRequest({ method: 'GET', pathname: '/api/orchestration/routing/catalog', runtime });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body.supportedAgents, ['codex']);
  assert.deepEqual(response.body.capabilities.hermes, {
    modelDiscovery: false, modelSwitch: false, reasoningControl: false, profileVerification: false,
  });
});

test('routing catalog API exposes the agent version and per-model supported reasoning values', async () => {
  const { runtime } = setup({
    routingNativeCapability: {
      listModels: async () => ({
        agentVersion: '0.151.0',
        data: [{
          id: 'gpt-5.6-luna', displayName: 'GPT-5.6-Luna', multiAgentVersion: 'v1',
          defaultReasoningEffort: 'medium',
          supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }, { reasoningEffort: 'max' }],
        }],
      }),
    },
  });
  try {
    const response = await handleOrchestrationRequest({ method: 'GET', pathname: '/api/orchestration/routing/catalog', runtime });
    assert.equal(response.body.catalog.agentVersion, '0.151.0');
    assert.deepEqual(response.body.catalog.models[0].supportedReasoningLevels, ['low', 'medium', 'max']);
    assert.equal(response.body.catalog.models[0].multiAgentVersion, 'v1');
  } finally {
    runtime.auto.stopPeriodicReconciliation();
  }
});

test('routing configuration rejects non-Codex workflows', async () => {
  const { dir, runtime } = setup();
  const created = await handleOrchestrationRequest({
    method: 'POST', pathname: '/api/orchestration/workflows', runtime,
    body: { projectPath: path.join(dir, 'app'), goal: 'route', agent: 'claude', verify: { dod: ['完成'] } },
  });
  await assert.rejects(
    handleOrchestrationRequest({ method: 'POST', pathname: `/api/orchestration/workflows/${created.body.workflow.id}/routing`, runtime, body: { enabled: true } }),
    (error) => error && error.code === 'ROUTING_AGENT_UNSUPPORTED',
  );
});

test('routing configuration accepts an injected second-agent adapter without agent-specific HTTP logic', async () => {
  const { dir, runtime } = setup();
  runtime.routing = createRoutingRuntime({
    agentCapabilities: {
      hermes: {
        listModels: async () => ({ models: [{ id: 'hermes-strong', supportedReasoningLevels: ['high'] }] }),
        applyProfile: async ({ profile }) => ({ readback: profile, verified: true }),
      },
    },
    cachePath: path.join(dir, 'second-agent-routing-cache.json'),
  });
  const created = runtime.store.create({
    projectPath: path.join(dir, 'hermes-app'), agent: 'hermes', mode: 'project',
    routingConfig: { enabled: true, preset: 'balanced' },
  });
  const current = await handleOrchestrationRequest({
    method: 'GET', pathname: `/api/orchestration/workflows/${created.id}/routing`, runtime,
  });
  assert.equal(current.status, 200);
  assert.equal(current.body.supported, true);
  assert.equal(current.body.catalog.models[0].id, 'hermes-strong');
  const updated = await handleOrchestrationRequest({
    method: 'POST', pathname: `/api/orchestration/workflows/${created.id}/routing`, runtime,
    body: { config: { enabled: true, preset: 'quality' } },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.workflow.routingConfig.enabled, true);
});

test('routing overview exposes safe diagnostics, audit timeline, usage state, and receipt', async () => {
  const { dir, runtime } = setup();
  const created = await handleOrchestrationRequest({
    method: 'POST', pathname: '/api/orchestration/workflows', runtime,
    body: {
      projectPath: path.join(dir, 'app'), goal: 'route', agent: 'codex', verify: { dod: ['完成'] },
      routingConfig: { enabled: true, preset: 'balanced', manualPin: { modelId: 'strong', reasoningLevel: 'high' } },
    },
  });
  const id = created.body.workflow.id;
  runtime.store.recordRouting(id, {
    summary: {
      enabled: true, action: 'apply', reasonCode: 'MANUAL_PIN', complexityTier: 'C1', thinkingTier: 'T1',
      promptPolicy: 'P1', modelId: 'strong', reasoningLevel: 'high', source: 'native', verified: true,
    },
    auditEvent: {
      schemaVersion: 1, event: 'profile_verified', generatedAt: '2026-08-30T12:00:00.000Z',
      fingerprint: 'route-1', route: { action: 'apply', reasonCode: 'MANUAL_PIN', complexityTier: 'C1', thinkingTier: 'T1', promptPolicy: 'P1' },
      profile: { modelId: 'strong', reasoningLevel: 'high', source: 'native', verified: true }, catalog: { source: 'native', stale: false },
      instruction: 'must not escape', token: 'must not escape',
    },
  });
  runtime.store.updateFields(id, {
    runReceipt: {
      version: 1, runId: id, agent: 'codex', goal: 'route', iterations: 1,
      dod: { passed: 0, total: 1 }, finalState: 'PAUSED', stopReason: 'Need Human',
      counters: { consecutiveFailures: 0, stagnation: 0, dispatchFailures: 0, routingEscalations: 0, routingDowngrades: 0 },
      routing: { modelId: 'strong', reasoningLevel: 'high', verified: true }, generatedAt: '2026-08-30T12:01:00.000Z',
      instruction: 'must not escape', token: 'must not escape',
    },
  }, 'test_receipt');

  const overview = await handleOrchestrationRequest({
    method: 'GET', pathname: `/api/orchestration/workflows/${id}/routing/overview`, runtime,
  });

  assert.equal(overview.status, 200);
  assert.equal(overview.body.diagnostics.workflowId, id);
  assert.equal(overview.body.diagnostics.compatibility.supported, true);
  assert.equal(overview.body.auditTimeline.length, 1);
  assert.equal(overview.body.auditTimeline[0].reasonCode, 'MANUAL_PIN');
  assert.equal(overview.body.usage.cost.available, false);
  assert.equal(overview.body.usage.quota.reasonCode, 'QUOTA_DATA_UNAVAILABLE');
  assert.equal(overview.body.receipt.runId, id);
  assert.equal(JSON.stringify(overview.body).includes('must not escape'), false);

  const audit = await handleOrchestrationRequest({
    method: 'GET', pathname: `/api/orchestration/workflows/${id}/routing/audit`, runtime,
  });
  assert.deepEqual(audit.body.items, overview.body.auditTimeline);
});

test('routing insights expose historical outcomes and workspace safety without blocking unavailable catalogs', async () => {
  const { dir, runtime } = setup();
  const created = await handleOrchestrationRequest({
    method: 'POST', pathname: '/api/orchestration/workflows', runtime,
    body: { projectPath: path.join(dir, 'app'), goal: 'insights', agent: 'codex', verify: { dod: ['完成'] } },
  });
  const id = created.body.workflow.id;
  runtime.store.appendDispatchRecord(id, {
    state: 'committed', routing: { modelId: 'strong', reasoningLevel: 'high' },
    instruction: 'must not escape', token: 'must not escape',
  });

  const response = await handleOrchestrationRequest({
    method: 'GET', pathname: `/api/orchestration/workflows/${id}/routing/insights`, runtime,
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.outcomes.totalSuccesses, 1);
  assert.deepEqual(response.body.workspace, { safe: true, reasonCode: 'WORKSPACE_IN_SCOPE' });
  assert.equal(response.body.recommendation.reasonCode, 'ROUTING_UNAVAILABLE');
  assert.equal(JSON.stringify(response.body).includes('must not escape'), false);
});

test('workspace routing insights expose bounded historical outcomes by Agent', async () => {
  const { dir, runtime } = setup();
  const codex = runtime.store.create({ projectPath: path.join(dir, 'codex-app'), agent: 'codex' });
  const hermes = runtime.store.create({ projectPath: path.join(dir, 'hermes-app'), agent: 'hermes' });
  runtime.store.appendDispatchRecord(codex.id, {
    state: 'committed', routing: { modelId: 'strong', reasoningLevel: 'high' }, instruction: 'must not escape',
  });
  runtime.store.appendDispatchRecord(hermes.id, {
    state: 'failed', routing: { modelId: 'balanced', reasoningLevel: 'medium' }, token: 'must not escape',
  });

  const response = await handleOrchestrationRequest({
    method: 'GET', pathname: '/api/orchestration/routing/insights', runtime,
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.scope, 'workspace');
  assert.equal(response.body.totalAttempts, 2);
  assert.deepEqual(response.body.agents, [
    { agent: 'codex', attempts: 1, successes: 1, failures: 0, successRate: 1 },
    { agent: 'hermes', attempts: 1, successes: 0, failures: 1, successRate: 0 },
  ]);
  assert.equal(JSON.stringify(response.body).includes('must not escape'), false);
});

test('workspace routing insights expose task metrics and same-class profile recommendations', async () => {
  const { dir, runtime } = setup();
  runtime.routing = {
    supportedAgents: () => ['codex'],
    getCatalog: async () => ({ source: 'native', available: true, stale: false, models: [
      { id: 'strong', visibility: 'list', supportedInApi: true, supportedReasoningLevels: ['high'] },
      { id: 'balanced', visibility: 'list', supportedInApi: true, supportedReasoningLevels: ['medium'] },
    ] }),
  };
  for (let index = 0; index < 3; index += 1) {
    const workflow = runtime.store.create({
      projectPath: path.join(dir, `codex-${index}`), agent: 'codex', classification: { kind: 'existing' },
    });
    runtime.store.updateFields(workflow.id, {
      startedAt: 1_000, endedAt: 3_000,
      runReceipt: {
        finalState: 'DONE', iterations: 1, dod: { passed: 1, total: 1 }, counters: { stagnation: 0 },
        routing: { modelId: 'balanced', reasoningLevel: 'medium' },
      },
    }, 'receipt_created');
  }

  const response = await handleOrchestrationRequest({
    method: 'GET', pathname: '/api/orchestration/routing/insights', runtime,
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.taskClasses[0].taskClass, 'existing');
  assert.equal(response.body.taskClasses[0].averageDurationMs, 2_000);
  assert.deepEqual(response.body.recommendations, [{
    agent: 'codex', taskClass: 'existing', sampleSize: 3, minAttempts: 3,
    reasonCode: 'HISTORICAL_PROFILE_RECOMMENDED',
    profile: {
      modelId: 'balanced', reasoningLevel: 'medium', complexityTier: 'C1', thinkingTier: 'T1', promptPolicy: 'P1',
      fallbackApplied: false, fallbackReason: null, reasonCode: 'PROFILE_RESOLVED',
    },
  }]);
  assert.equal(JSON.stringify(response.body).includes('codex-0'), false);
});

test('routing catalog refresh and profile test are explicit, safe, and never dispatch', async () => {
  const { dir, runtime } = setup();
  const calls = [];
  runtime.routing = {
    supportedAgents: () => ['codex'],
    getCatalog: async () => ({ source: 'native', available: true, stale: false, models: [{ id: 'strong' }] }),
    refreshCatalog: async ({ agent }) => { calls.push(['refresh', agent]); return { source: 'native', available: true, stale: false, models: [{ id: 'strong' }] }; },
    testProfile: async ({ modelId, reasoningLevel }) => {
      calls.push(['test', modelId, reasoningLevel]);
      return { ok: true, code: 'PROFILE_TEST_VERIFIED', profile: { modelId, reasoningLevel }, dispatchAllowed: false };
    },
  };
  const refresh = await handleOrchestrationRequest({
    method: 'POST', pathname: '/api/orchestration/routing/catalog/refresh', runtime, body: { agent: 'codex', command: 'drop' },
  });
  assert.equal(refresh.status, 200);
  assert.equal(refresh.body.catalog.source, 'native');
  assert.deepEqual(calls, [['refresh', 'codex']]);

  const created = await handleOrchestrationRequest({
    method: 'POST', pathname: '/api/orchestration/workflows', runtime,
    body: { projectPath: path.join(dir, 'app'), goal: 'test profile', agent: 'codex', verify: { dod: ['完成'] } },
  });
  const response = await handleOrchestrationRequest({
    method: 'POST', pathname: `/api/orchestration/workflows/${created.body.workflow.id}/routing/test`, runtime,
    body: { modelId: 'strong', reasoningLevel: 'high', instruction: 'drop' },
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.dispatchAllowed, false);
  assert.equal(JSON.stringify(response.body).includes('drop'), false);
  assert.deepEqual(calls, [['refresh', 'codex'], ['test', 'strong', 'high']]);
});

test('orchestration errors expose stable recovery codes', async () => {
  const { runtime } = setup();
  const response = await handleOrchestrationRequest({
    method: 'GET', pathname: '/api/orchestration/workflows/missing-workflow', runtime,
  });
  assert.equal(response.status, 404);
  assert.equal(response.body.code, 'WORKFLOW_NOT_FOUND');
});
