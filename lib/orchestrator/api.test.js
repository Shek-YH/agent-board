'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { WorkflowStore } = require('./workflow-store');
const {
  createWorkflowRequest,
  getOrchestrationState,
  takeoverWorkflow,
  transitionWorkflow,
} = require('./api');

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-api-'));
  return { dir, store: new WorkflowStore(path.join(dir, 'workflows.json')) };
}

test('createWorkflowRequest classifies project and persists structured plan', () => {
  const { dir, store } = makeStore();
  const result = createWorkflowRequest({
    projectPath: path.join(dir, 'new-app'), goal: '创建一个最小 API 服务', mode: 'global',
    agent: 'codex', requestedBy: 'jarvis', allowedRoots: [dir], store,
  });
  assert.equal(result.classification.kind, 'new');
  assert.equal(result.plan.mode, 'new');
  assert.equal(result.workflow.mode, 'global');
  assert.equal(result.workflow.requestedBy, 'jarvis');
  assert.equal(result.workflow.executionPlan.actions.initializeGit, true);
  assert.equal(store.get(result.workflow.id).executionPlan.goal, '创建一个最小 API 服务');
});

test('createWorkflowRequest rejects a project outside the configured roots', () => {
  const { dir, store } = makeStore();
  assert.throws(() => createWorkflowRequest({
    projectPath: path.join(os.tmpdir(), 'outside-agent-board'), goal: 'x',
    allowedRoots: [dir], store,
  }), /outside allowed roots/);
  assert.equal(store.list().length, 0);
});

test('workflow API exposes provider readiness without returning secrets', () => {
  const { store } = makeStore();
  const state = getOrchestrationState({
    store,
    env: { DASHSCOPE_API_KEY: 'secret-value', ELEVENLABS_API_KEY: '' },
  });
  assert.equal(state.capabilities.supervisor_llm.available, true);
  assert.equal(state.capabilities.supervisor_llm.provider, 'dashscope');
  assert.equal(state.capabilities.supervisor_llm.providerName, '阿里云百炼');
  assert.equal(JSON.stringify(state).includes('secret-value'), false);
});

test('takeover changes control owner and pauses an AI workflow', () => {
  const { dir, store } = makeStore();
  const { workflow } = createWorkflowRequest({ projectPath: path.join(dir, 'app'), goal: 'x', store });
  store.transition(workflow.id, 'queued');
  const running = store.transition(workflow.id, 'running');
  assert.equal(running.status, 'running');
  const taken = takeoverWorkflow({ store, id: workflow.id });
  assert.equal(taken.controlOwner, 'human');
  assert.equal(taken.status, 'paused');
  const queued = transitionWorkflow({ store, id: workflow.id, status: 'queued' });
  assert.equal(queued.status, 'queued');
});
