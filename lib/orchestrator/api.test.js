'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { WorkflowStore } = require('./workflow-store');
const { DEFAULT_SETTINGS } = require('./settings-store');
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
    verify: { dod: ['测试通过'], evidence: ['node --test'] },
  });
  assert.equal(result.classification.kind, 'new');
  assert.equal(result.plan.mode, 'new');
  assert.equal(result.workflow.mode, 'global');
  assert.equal(result.workflow.requestedBy, 'jarvis');
  assert.equal(result.workflow.executionPlan.actions.initializeGit, true);
  assert.equal(store.get(result.workflow.id).executionPlan.goal, '创建一个最小 API 服务');
  assert.equal(result.workflow.autopilotMode, 'suggest');
  assert.deepEqual(result.workflow.runContract.verify.dod, ['测试通过']);
});

test('createWorkflowRequest rejects a project outside the configured roots', () => {
  const { dir, store } = makeStore();
  assert.throws(() => createWorkflowRequest({
    projectPath: path.join(os.tmpdir(), 'outside-agent-board'), goal: 'x',
    allowedRoots: [dir], store, verify: { dod: ['完成'] },
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

test('createWorkflowRequest rejects incomplete contracts and drops command fields', () => {
  const { dir, store } = makeStore();
  assert.throws(() => createWorkflowRequest({
    projectPath: path.join(dir, 'app'), goal: 'x', allowedRoots: [dir], store,
  }), /DoD/);
  const auto = createWorkflowRequest({
    projectPath: path.join(dir, 'auto'), goal: 'x', autopilotMode: 'auto',
    binding: { sessionRef: 'session-1', agent: 'codex', projectPath: path.join(dir, 'auto') },
    verify: { dod: ['完成'] }, allowedRoots: [dir], store,
  });
  assert.equal(auto.workflow.autopilotMode, 'auto');
  assert.equal(auto.workflow.binding.sessionRef, 'session-1');
  const result = createWorkflowRequest({
    projectPath: path.join(dir, 'safe'), goal: 'x', verify: { dod: ['完成'] },
    commands: ['rm -rf /'], transport: { run: 'unsafe' }, allowedRoots: [dir], store,
  });
  assert.equal('commands' in result.workflow, false);
  assert.equal('transport' in result.workflow, false);
});

test('createWorkflowRequest persists safe hosted task relation metadata', () => {
  const { dir, store } = makeStore();
  const result = createWorkflowRequest({
    projectPath: path.join(dir, 'hosted'), goal: '托管执行', autopilotMode: 'auto',
    binding: { sessionRef: 'codex:session-1', agent: 'codex', projectPath: path.join(dir, 'hosted') },
    hostedControl: {
      enabled: true, sourceTaskId: 'source-task', targetTaskId: 'target-task', hostId: 'host-1',
      lastAgentMessageText: '不得保存这段回复',
    },
    verify: { dod: ['完成'] }, allowedRoots: [dir], store,
  });
  assert.equal(result.workflow.hostedControl.enabled, true);
  assert.equal(result.workflow.hostedControl.targetTaskId, 'target-task');
  assert.equal('lastAgentMessageText' in result.workflow.hostedControl, false);
  assert.doesNotMatch(JSON.stringify(result.workflow), /不得保存这段回复/);
});

test('createWorkflowRequest stores normalized worker routing separately from supervisor input', () => {
  const { dir, store } = makeStore();
  const result = createWorkflowRequest({
    projectPath: path.join(dir, 'route-app'), goal: 'route', allowedRoots: [dir], store,
    verify: { dod: ['完成'] },
    supervisorConfig: { provider: 'openai', model: 'supervisor-model', apiKey: 'secret-value' },
    routingConfig: {
      enabled: true, preset: 'custom', complexityTier: 'C2', thinkingTier: 'T2',
      provider: 'deepseek', model: 'worker-model', baseUrl: 'https://api.deepseek.com/v1',
      temperature: '0.3', contextBudget: '64000', token: 'secret-token', commands: ['rm -rf /'],
    },
  });

  assert.equal(result.workflow.routingConfig.provider, 'deepseek');
  assert.equal(result.workflow.routingConfig.model, 'worker-model');
  assert.equal(result.workflow.routingConfig.temperature, 0.3);
  assert.equal(result.workflow.routingConfig.contextBudget, 64000);
  assert.equal('supervisorConfig' in result.workflow, false);
  assert.doesNotMatch(JSON.stringify(result.workflow), /secret-value|secret-token|rm -rf/);
});

test('createWorkflowRequest inherits persisted defaults when no per-workflow override is supplied', () => {
  const { dir, store } = makeStore();
  const settings = {
    ...DEFAULT_SETTINGS,
    autopilot: { ...DEFAULT_SETTINGS.autopilot, defaultMode: 'auto', maxIterations: 7, maxRuntimeMs: 90_000 },
    routing: { ...DEFAULT_SETTINGS.routing, enabled: true, preset: 'quality' },
  };
  const result = createWorkflowRequest({
    projectPath: path.join(dir, 'inherited'), goal: 'inherit defaults', allowedRoots: [dir], store, settings,
    verify: { dod: ['完成'] },
  });

  assert.equal(result.workflow.autopilotMode, 'auto');
  assert.equal(result.workflow.runContract.budget.maxIterations, 7);
  assert.equal(result.workflow.runContract.budget.maxRuntime, 90_000);
  assert.equal(result.workflow.routingConfig.enabled, true);
  assert.equal(result.workflow.routingConfig.preset, 'quality');
  assert.deepEqual(result.workflow.settingsSnapshot.autopilot, settings.autopilot);
});

test('explicit workflow values override persisted defaults for compatibility', () => {
  const { dir, store } = makeStore();
  const result = createWorkflowRequest({
    projectPath: path.join(dir, 'override'), goal: 'explicit', allowedRoots: [dir], store,
    settings: DEFAULT_SETTINGS, autopilotMode: 'suggest', budget: { maxIterations: 2, maxRuntime: 10_000 },
    routingConfig: { enabled: false, preset: 'save' }, verify: { dod: ['完成'] },
  });

  assert.equal(result.workflow.autopilotMode, 'suggest');
  assert.equal(result.workflow.runContract.budget.maxIterations, 2);
  assert.equal(result.workflow.routingConfig.enabled, false);
  assert.equal(result.workflow.routingConfig.preset, 'save');
});

test('orchestration state exposes read-only provider configuration and a stable unconfigured status', () => {
  const { store } = makeStore();
  const state = getOrchestrationState({ store, env: {} });

  assert.equal(state.providerConfig.readOnly, true);
  assert.equal(state.providerConfig.supervisor.reasonCode, 'SUPERVISOR_UNCONFIGURED');
  assert.equal(state.providerConfig.supervisor.available, false);
  assert.equal(state.providerConfig.baseAutoPilot.available, true);
  assert.equal(state.providerConfig.baseAutoPilot.blocking, false);
  assert.doesNotMatch(JSON.stringify(state), /API_KEY|apiKey|token/);
});

test('takeover changes control owner and pauses an AI workflow', () => {
  const { dir, store } = makeStore();
  const { workflow } = createWorkflowRequest({
    projectPath: path.join(dir, 'app'), goal: 'x', verify: { dod: ['完成'] }, store,
  });
  store.transition(workflow.id, 'queued');
  const running = store.transition(workflow.id, 'running');
  assert.equal(running.status, 'running');
  const taken = takeoverWorkflow({ store, id: workflow.id });
  assert.equal(taken.controlOwner, 'human');
  assert.equal(taken.status, 'paused');
  const queued = transitionWorkflow({ store, id: workflow.id, status: 'queued' });
  assert.equal(queued.status, 'queued');
});
