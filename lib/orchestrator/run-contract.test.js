'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeRunContract } = require('./run-contract');

const valid = {
  autopilotMode: 'suggest',
  goal: '完成登录模块',
  scope: { inScope: ['src'], outOfScope: ['部署'] },
  verify: { dod: ['测试通过'], evidence: ['node --test'] },
  budget: { maxIterations: 3, maxRuntime: 60_000, supervisorCostLimit: 0 },
  command: 'rm -rf /',
};

test('normalizes a safe suggest contract and drops command fields', () => {
  const contract = normalizeRunContract(valid);
  assert.equal(contract.version, 1);
  assert.equal(contract.autopilotMode, 'suggest');
  assert.deepEqual(contract.verify.dod, ['测试通过']);
  assert.equal('command' in contract, false);
  assert.equal(Object.isFrozen(contract), true);
});

test('rejects empty goal, missing DoD, unsupported mode, and invalid budget', () => {
  assert.throws(() => normalizeRunContract({ ...valid, goal: '' }), /goal/);
  assert.throws(() => normalizeRunContract({ ...valid, verify: { evidence: ['x'] } }), /DoD/);
  assert.throws(() => normalizeRunContract({ ...valid, autopilotMode: 'turbo' }), /suggest or auto/);
  assert.throws(() => normalizeRunContract({ ...valid, budget: { maxIterations: 0 } }), /maxIterations/);
});

test('accepts auto mode while keeping suggest as the default', () => {
  const contract = normalizeRunContract({ ...valid, autopilotMode: 'auto' });
  assert.equal(contract.autopilotMode, 'auto');
  assert.equal(normalizeRunContract({ ...valid }).autopilotMode, 'suggest');
});

test('keeps budget, runtime, failure, and stagnation limits in the immutable Run Contract', () => {
  const contract = normalizeRunContract({ ...valid, autopilotMode: 'auto', budget: {
    maxIterations: 8, maxRuntime: 90_000, maxBudget: 12.5, failureThreshold: 5, stagnationThreshold: 4, supervisorCostLimit: 0,
  } });
  assert.deepEqual(contract.budget, {
    maxIterations: 8, maxRuntime: 90_000, maxBudget: 12.5, failureThreshold: 5, stagnationThreshold: 4, supervisorCostLimit: 0,
  });
});

test('deduplicates and trims lists without retaining mutable input', () => {
  const input = { ...valid, scope: { inScope: [' src ', 'src'], outOfScope: [] } };
  const contract = normalizeRunContract(input);
  input.scope.inScope[0] = 'tampered';
  assert.deepEqual(contract.scope.inScope, ['src']);
});

test('keeps a short AI-compiled goal summary for the dispatched first turn', () => {
  const contract = normalizeRunContract({ ...valid, goalSummary: '修复登录并验证测试结果' });
  assert.equal(contract.goal, valid.goal);
  assert.equal(contract.goalSummary, '修复登录并验证测试结果');
  assert.equal(normalizeRunContract(valid).goalSummary, valid.goal);
});
