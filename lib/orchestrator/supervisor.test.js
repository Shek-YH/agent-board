'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { buildSupervisorDecision, sanitizeSupervisorDecision } = require('./supervisor');

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

