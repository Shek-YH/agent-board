'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { WorkflowStore } = require('./workflow-store');

function storePath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-workflow-'));
  return path.join(dir, 'workflows.json');
}

test('workflow transitions through the supported lifecycle', () => {
  const store = new WorkflowStore(storePath());
  const workflow = store.create({ projectPath: 'C:\\work\\app', mode: 'project', agent: 'codex' });
  assert.equal(workflow.status, 'draft');
  store.transition(workflow.id, 'queued');
  store.transition(workflow.id, 'running');
  store.transition(workflow.id, 'verifying');
  store.transition(workflow.id, 'completed');
  assert.equal(store.get(workflow.id).status, 'completed');
});

test('illegal workflow transition is rejected', () => {
  const store = new WorkflowStore(storePath());
  const workflow = store.create({ projectPath: 'C:\\work\\app', mode: 'project', agent: 'codex' });
  assert.throws(() => store.transition(workflow.id, 'completed'), /illegal workflow transition/);
});

test('only one active owner may control a project', () => {
  const store = new WorkflowStore(storePath());
  const first = store.create({ projectPath: 'C:\\work\\app', mode: 'project', agent: 'codex' });
  const second = store.create({ projectPath: 'C:\\work\\app', mode: 'project', agent: 'claude' });
  store.claim(first.id, 'ai', 60_000, 1000);
  assert.throws(() => store.claim(second.id, 'ai', 60_000, 1001), /project is already controlled/);
});

test('human takeover pauses AI ownership', () => {
  const store = new WorkflowStore(storePath());
  const workflow = store.create({ projectPath: 'C:\\work\\app', mode: 'project', agent: 'codex' });
  store.claim(workflow.id, 'ai', 60_000, 1000);
  store.takeover(workflow.id, 'human', 1001);
  const current = store.get(workflow.id);
  assert.equal(current.controlOwner, 'human');
  assert.equal(current.status, 'paused');
});

test('expired AI lease can be reclaimed', () => {
  const store = new WorkflowStore(storePath());
  const first = store.create({ projectPath: 'C:\\work\\app', mode: 'project', agent: 'codex' });
  const second = store.create({ projectPath: 'C:\\work\\app', mode: 'project', agent: 'claude' });
  store.claim(first.id, 'ai', 10, 1000);
  store.claim(second.id, 'ai', 60_000, 1011);
  assert.equal(store.get(second.id).controlOwner, 'ai');
});
