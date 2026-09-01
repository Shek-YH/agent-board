'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { applySupervisorReview, buildSupervisorDecision, sanitizeSupervisorDecision } = require('./supervisor');

function workflow(fields = {}) {
  return {
    id: 'wf-1', agent: 'codex', projectPath: 'C:\\Projects\\demo', lastError: '',
    runContract: {
      goal: '修复登录测试', scope: { inScope: ['src/auth'], outOfScope: ['部署'] },
      verify: { dod: ['单元测试通过', 'E2E 测试通过'] }, stop: ['DoD Complete'],
    },
    ...fields,
  };
}

test('supervisor creates a structured continuation decision with a constrained turn contract', () => {
  const result = buildSupervisorDecision({
    workflow: workflow(),
    progress: { status: 'in_progress', completed: 0, total: 2, evidence: [], stopReason: null },
  });
  assert.equal(result.schemaVersion, '2.2');
  assert.equal(result.decision, 'CONTINUE');
  assert.equal(result.turnContract.action, 'repair');
  assert.deepEqual(result.turnContract.targetDodItems, ['dod-1', 'dod-2']);
  assert.match(result.instruction, /修复登录测试/);
  assert.equal('command' in result, false);
});

test('supervisor dispatches the AI-compiled summary while retaining scope and DoD constraints', () => {
  const result = buildSupervisorDecision({
    workflow: workflow({ runContract: {
      goal: '这是很长的原始目标，包含表单输入和上下文',
      goalSummary: '修复登录并完成验证',
      scope: { inScope: ['src/auth'], outOfScope: ['部署'] },
      verify: { dod: ['单元测试通过'] }, stop: ['DoD Complete'],
    } }),
    progress: { status: 'in_progress', evidence: [], stopReason: null },
  });
  assert.match(result.instruction, /修复登录并完成验证/);
  assert.doesNotMatch(result.instruction, /这是很长的原始目标/);
  assert.match(result.instruction, /src\/auth/);
  assert.match(result.instruction, /单元测试通过/);
  assert.equal(result.turnContract.expectedResult, '修复登录并完成验证');
});

test('supervisor stops only with explicit complete evidence and persists no full instruction', () => {
  const result = buildSupervisorDecision({
    workflow: workflow(),
    progress: {
      status: 'completed', completed: 2, total: 2,
      evidence: [
        { dodIndex: 0, passed: true, summary: 'unit ok', source: 'test' },
        { dodIndex: 1, passed: true, summary: 'e2e ok', source: 'test' },
      ], stopReason: null,
    },
  });
  assert.equal(result.decision, 'DONE');
  const safe = sanitizeSupervisorDecision(result);
  assert.equal('instruction' in safe, false);
  assert.deepEqual(safe.dodChecks.map((item) => item.status), ['pass', 'pass']);
});

test('AI Supervisor cannot override a deterministic CONTINUE decision with DONE', () => {
  const decision = buildSupervisorDecision({
    workflow: workflow(), progress: { status: 'in_progress', evidence: [], stopReason: null },
  });
  const reviewed = applySupervisorReview({
    workflow: workflow(), progress: { status: 'in_progress', evidence: [], stopReason: null }, decision,
    reviewResult: { source: 'model', provider: 'zai', model: 'glm-test', review: { decision: 'DONE', summary: '模型误判', dodChecks: [] } },
  });
  assert.equal(reviewed.decision, 'CONTINUE');
  assert.equal(reviewed.review.decision, 'DONE');
});

test('AI Supervisor requests another verification turn when deterministic completion is not confirmed', () => {
  const current = workflow();
  const progress = {
    status: 'completed', completed: 2, total: 2,
    evidence: [
      { dodIndex: 0, passed: true, summary: 'unit', source: 'test' },
      { dodIndex: 1, passed: true, summary: 'e2e', source: 'test' },
    ], stopReason: null,
  };
  const decision = buildSupervisorDecision({ workflow: current, progress });
  const reviewed = applySupervisorReview({
    workflow: current, progress, decision,
    reviewResult: {
      source: 'model', provider: 'zai', model: 'glm-test',
      review: { decision: 'CONTINUE', summary: '第二项缺少证据', dodChecks: [{ index: 1, status: 'pending', reason: '证据不足' }] },
    },
  });
  assert.equal(reviewed.decision, 'CONTINUE');
  assert.equal(reviewed.reasonCode, 'AI_REVIEW_REQUESTED_VERIFICATION');
  assert.deepEqual(reviewed.turnContract.targetDodItems, ['dod-2']);
  assert.match(reviewed.instruction, /E2E 测试通过/);
});

test('AI Supervisor NEED_HUMAN pauses without generating an instruction', () => {
  const current = workflow();
  const progress = { status: 'in_progress', evidence: [], stopReason: null };
  const decision = buildSupervisorDecision({ workflow: current, progress });
  const reviewed = applySupervisorReview({
    workflow: current, progress, decision,
    reviewResult: { source: 'model', provider: 'zai', model: 'glm-test', review: { decision: 'NEED_HUMAN', summary: '发现潜在越权', dodChecks: [] } },
  });
  assert.equal(reviewed.decision, 'NEED_HUMAN');
  assert.equal(reviewed.turnContract.action, 'pause');
  assert.equal(reviewed.instruction, '');
});
