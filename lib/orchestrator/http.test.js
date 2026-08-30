'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { handleOrchestrationRequest } = require('./http');
const { createOrchestrationRuntime } = require('./runtime');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-http-'));
  const runtime = createOrchestrationRuntime({
    env: { AGENT_BOARD_ALLOWED_ROOTS: dir, AGENT_BOARD_HEADLESS_EXECUTION: '0' },
    filePath: path.join(dir, 'workflows.json'),
  });
  return { dir, runtime };
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
    body: { projectPath: path.join(dir, 'app'), goal: 'x', agent: 'codex', verify: { dod: ['完成'] } },
  });
  const id = created.body.workflow.id;
  const accepted = await handleOrchestrationRequest({ method: 'POST', pathname: `/api/orchestration/workflows/${id}/run`, runtime, body: {} });
  assert.equal(accepted.status, 409);
  assert.equal(accepted.body.code, 'SUGGEST_ONLY');
  assert.equal('background' in accepted, false);
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
