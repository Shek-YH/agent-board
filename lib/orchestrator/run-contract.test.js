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
  assert.throws(() => normalizeRunContract({ ...valid, autopilotMode: 'auto' }), /suggest/);
  assert.throws(() => normalizeRunContract({ ...valid, budget: { maxIterations: 0 } }), /maxIterations/);
});

test('deduplicates and trims lists without retaining mutable input', () => {
  const input = { ...valid, scope: { inScope: [' src ', 'src'], outOfScope: [] } };
  const contract = normalizeRunContract(input);
  input.scope.inScope[0] = 'tampered';
  assert.deepEqual(contract.scope.inScope, ['src']);
});
