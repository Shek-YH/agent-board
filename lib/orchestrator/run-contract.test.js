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

test('normalizes an ordered handoff chain and explicit step budget limits', () => {
  const contract = normalizeRunContract({ ...valid, autopilotMode: 'auto', budget: {
    maxIterations: 6, maxRuntime: 120_000, maxStepRuntime: 30_000, maxRetries: 2, maxBudget: 3,
  }, handoffChain: [
    { id: 'implement', order: 1, agent: 'codex', goal: '实现修复', dod: ['测试通过'], evidence: ['node --test'], dependsOn: [] },
    { id: 'review', order: 2, agent: 'claude', goal: '审核修复', dod: ['审核通过'], evidence: ['审核记录'], dependsOn: ['implement'] },
  ] });

  assert.ok(Array.isArray(contract.handoffChain));
  if (!Array.isArray(contract.handoffChain)) return;
  assert.deepEqual(contract.handoffChain.map((step) => ({
    id: step.id, order: step.order, agent: step.agent, dependsOn: step.dependsOn, status: step.status,
  })), [
    { id: 'implement', order: 1, agent: 'codex', dependsOn: [], status: 'pending' },
    { id: 'review', order: 2, agent: 'claude', dependsOn: ['implement'], status: 'pending' },
  ]);
  assert.equal(contract.budget.maxStepRuntime, 30_000);
  assert.equal(contract.budget.maxRetries, 2);
  assert.equal(Object.isFrozen(contract.handoffChain[0]), true);
});

test('rejects a handoff dependency that is ordered after its dependent step', () => {
  assert.throws(() => normalizeRunContract({ ...valid, handoffChain: [
    { id: 'review', order: 1, agent: 'claude', goal: '审核', dod: ['通过'], dependsOn: ['build'] },
    { id: 'build', order: 2, agent: 'codex', goal: '构建', dod: ['完成'], dependsOn: [] },
  ] }), /precede|order|顺序/);
});

test('does not accept a precompleted handoff step without verified evidence', () => {
  assert.throws(() => normalizeRunContract({ ...valid, handoffChain: [
    { id: 'build', order: 1, agent: 'codex', goal: '构建', dod: ['完成'], status: 'done', dependsOn: [] },
  ] }), /DONE requires verified evidence|verified evidence/);
});

test('redacts secret-like handoff text before persistence and model input', () => {
  const contract = normalizeRunContract({ ...valid, handoffChain: [{
    id: 'review', order: 1, agent: 'claude',
    goal: '检查 token=handoff-secret',
    dod: ['不要输出 cookie=session-secret'],
    evidence: ['password: evidence-secret'], dependsOn: [],
  }] });
  const serialized = JSON.stringify(contract);
  assert.doesNotMatch(serialized, /handoff-secret|session-secret|evidence-secret/);
  assert.match(serialized, /\[REDACTED\]/);
});

test('persists bounded per-step research state without raw source content', () => {
  const contract = normalizeRunContract({ ...valid, handoffChain: [{
    id: 'review', order: 1, agent: 'claude', goal: '审核', dod: ['通过'], dependsOn: [],
    researchState: {
      status: 'completed', attempts: 1, confidence: 0.88,
      sources: [{ kind: 'external', url: 'https://docs.example.com/a', title: 'Docs', content: 'raw secret' }],
      unresolvedQuestions: ['是否使用 token=secret'], needsHumanReason: 'prompt=secret',
    },
  }] });
  const serialized = JSON.stringify(contract);
  assert.equal(contract.handoffChain[0].researchState.status, 'completed');
  assert.equal(contract.handoffChain[0].researchState.confidence, 0.88);
  assert.equal(contract.handoffChain[0].researchState.sources[0].url, 'https://docs.example.com/a');
  assert.doesNotMatch(serialized, /raw secret|token=secret|prompt=secret/);
});
