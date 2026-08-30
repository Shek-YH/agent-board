'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { WorkflowStore } = require('./workflow-store');
const { createWorkflowRequest } = require('./api');
const { WorkflowRunner } = require('./runner');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-runner-'));
  return { dir, store: new WorkflowStore(path.join(dir, 'workflows.json')) };
}

test('runner executes project lifecycle then completes a successful worker run', async () => {
  const { dir, store } = setup();
  const created = createWorkflowRequest({
    projectPath: path.join(dir, 'new-app'), goal: '创建项目', verify: { dod: ['完成项目'] }, store,
  });
  const runner = new WorkflowRunner({
    store,
    allowedRoots: [dir],
    transport: { run: async () => ({ status: 'completed', code: 0, output: 'ok' }) },
    runCommand: () => ({ code: 0, stdout: '', stderr: '' }),
  });
  const result = await runner.run(created.workflow.id);
  assert.equal(result.status, 'completed');
  assert.equal(store.get(created.workflow.id).status, 'completed');
  assert.equal(store.get(created.workflow.id).runCount, 1);
});

test('runner pauses when project lifecycle needs human approval', async () => {
  const { dir, store } = setup();
  const project = path.join(dir, 'existing');
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'package.json'), '{}');
  const created = createWorkflowRequest({
    projectPath: project, goal: '维护项目', verify: { dod: ['完成维护'] }, store,
  });
  const runner = new WorkflowRunner({
    store, allowedRoots: [dir], transport: { run: async () => ({ status: 'completed', code: 0 }) },
  });
  const result = await runner.run(created.workflow.id);
  assert.equal(result.status, 'waiting_user');
  assert.match(store.get(created.workflow.id).lastError, /人工确认/);
});

test('runner records worker failure and releases the project lease', async () => {
  const { dir, store } = setup();
  const created = createWorkflowRequest({
    projectPath: path.join(dir, 'new-app'), goal: '失败任务', verify: { dod: ['任务通过'] }, store,
  });
  const runner = new WorkflowRunner({
    store, allowedRoots: [dir],
    transport: { run: async () => ({ status: 'failed', code: 2, error: 'worker failed' }) },
    runCommand: () => ({ code: 0, stdout: '', stderr: '' }),
  });
  const result = await runner.run(created.workflow.id);
  assert.equal(result.status, 'failed');
  assert.equal(store.get(created.workflow.id).controlOwner, null);
  assert.equal(store.get(created.workflow.id).lastError, 'worker failed');
});

test('runner cannot resume a workflow held by human takeover', async () => {
  const { dir, store } = setup();
  const created = createWorkflowRequest({
    projectPath: path.join(dir, 'new-app'), goal: 'x', verify: { dod: ['完成'] }, store,
  });
  store.takeover(created.workflow.id, 'human');
  let spawned = false;
  const runner = new WorkflowRunner({
    store, allowedRoots: [dir], transport: { run: async () => { spawned = true; return { status: 'completed', code: 0 }; } },
  });
  const result = await runner.run(created.workflow.id);
  assert.equal(result.status, 'paused');
  assert.equal(result.controlOwner, 'human');
  assert.equal(spawned, false);
});
