'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { buildExecutionPlan } = require('./execution-plan');
const { classifyProject } = require('./project-classifier');
const { executeProjectPlan } = require('./project-lifecycle');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-lifecycle-'));
}

test('new project creates its directory, initializes git, and verifies it', () => {
  const root = tempDir();
  const projectPath = path.join(root, 'new-app');
  const commands = [];
  const plan = buildExecutionPlan({ classification: classifyProject(projectPath), goal: '创建应用' });
  const result = executeProjectPlan(plan, {
    allowedRoots: [root],
    runCommand(command, args, options) {
      commands.push({ command, args, options });
      if (command === 'git' && args[0] === 'status') return { code: 0, stdout: '', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    },
  });
  assert.equal(result.status, 'ready');
  assert.equal(fs.existsSync(projectPath), true);
  assert.deepEqual(commands.map((item) => [item.command, ...item.args]), [
    ['git', 'init'], ['git', 'status', '--short'],
  ]);
});

test('existing dirty project pauses before execution', () => {
  const root = tempDir();
  const projectPath = path.join(root, 'existing');
  fs.mkdirSync(path.join(projectPath, '.git'), { recursive: true });
  const plan = buildExecutionPlan({ classification: classifyProject(projectPath), goal: '维护应用' });
  const result = executeProjectPlan(plan, {
    allowedRoots: [root],
    runCommand() { return { code: 0, stdout: ' M src/app.js\n', stderr: '' }; },
  });
  assert.equal(result.status, 'waiting_user');
  assert.match(result.reason, /未提交/);
});

test('existing unversioned project cannot initialize git without approval', () => {
  const root = tempDir();
  const projectPath = path.join(root, 'legacy');
  fs.mkdirSync(projectPath, { recursive: true });
  fs.writeFileSync(path.join(projectPath, 'package.json'), '{}');
  const plan = buildExecutionPlan({ classification: classifyProject(projectPath), goal: '维护旧应用' });
  assert.throws(() => executeProjectPlan(plan, { allowedRoots: [root], runCommand() { return { code: 0 }; } }), /approval required/);
});

test('project outside allowed roots is rejected before filesystem changes', () => {
  const allowed = tempDir();
  const outside = tempDir();
  const projectPath = path.join(outside, 'new-app');
  const plan = buildExecutionPlan({ classification: classifyProject(projectPath), goal: '不应执行' });
  assert.throws(() => executeProjectPlan(plan, { allowedRoots: [allowed] }), /outside allowed roots/);
  assert.equal(fs.existsSync(projectPath), false);
});
