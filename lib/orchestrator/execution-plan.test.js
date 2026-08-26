'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { buildExecutionPlan } = require('./execution-plan');

test('new project plan initializes git and includes baseline verification', () => {
  const plan = buildExecutionPlan({
    classification: { kind: 'new', canonicalPath: 'C:\\work\\demo' },
    goal: '创建一个 Node 服务',
  });
  assert.equal(plan.mode, 'new');
  assert.equal(plan.projectPath, 'C:\\work\\demo');
  assert.equal(plan.actions.createDirectory, true);
  assert.equal(plan.actions.initializeGit, true);
  assert.deepEqual(plan.verification, ['git status --short']);
  assert.equal(plan.requiresApproval, false);
});

test('maintenance plan preserves a git project and checks dirty state first', () => {
  const plan = buildExecutionPlan({
    classification: { kind: 'existing', canonicalPath: 'C:\\work\\app' },
    goal: '修复登录测试',
  });
  assert.equal(plan.mode, 'maintenance');
  assert.equal(plan.projectPath, 'C:\\work\\app');
  assert.equal(plan.actions.createDirectory, false);
  assert.equal(plan.actions.initializeGit, false);
  assert.deepEqual(plan.preflight, ['git status --short']);
});

test('unversioned existing projects require approval before git initialization', () => {
  const plan = buildExecutionPlan({
    classification: { kind: 'existing_unversioned', canonicalPath: 'C:\\work\\legacy' },
    goal: '维护旧项目',
  });
  assert.equal(plan.mode, 'maintenance');
  assert.equal(plan.actions.initializeGit, false);
  assert.equal(plan.requiresApproval, true);
  assert.match(plan.approvalReason, /Git/);
});

test('invalid classification cannot produce an execution plan', () => {
  assert.throws(() => buildExecutionPlan({
    classification: { kind: 'invalid', canonicalPath: '' },
    goal: '不应执行',
  }), /invalid project/);
});
