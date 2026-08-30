'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { calculateProgress } = require('./progress');
const { normalizeRunContract } = require('./run-contract');

const contract = normalizeRunContract({
  goal: '完成目标', verify: { dod: ['测试通过', '检查完成'], evidence: ['测试结果'] },
});

function workflow(fields = {}) {
  return {
    id: 'wf-1', status: 'draft', controlOwner: null, runCount: 0,
    createdAt: 1_000, runContract: contract, lastResult: null,
    observedEvidence: [], ...fields,
  };
}

test('starts without claiming any DoD evidence', () => {
  assert.deepEqual(calculateProgress({ workflow: workflow(), now: 2_000 }), {
    status: 'not_started', completed: 0, total: 2, percent: 0, evidence: [], stopReason: null,
  });
});

test('counts only explicit passed evidence and never parses stdout', () => {
  const result = calculateProgress({ workflow: workflow({
    lastResult: { stdout: '测试通过\n检查完成' },
    observedEvidence: [{ dodIndex: 0, passed: true, summary: '测试通过', source: 'test' }],
  }), now: 2_000 });
  assert.equal(result.status, 'in_progress');
  assert.equal(result.completed, 1);
});

test('marks complete only when every DoD has explicit passed evidence', () => {
  const result = calculateProgress({ workflow: workflow({
    status: 'completed',
    observedEvidence: [
      { dodIndex: 0, passed: true, summary: 'ok', source: 'test' },
      { dodIndex: 1, passed: true, summary: 'ok', source: 'git' },
    ],
  }), now: 2_000 });
  assert.equal(result.status, 'completed');
  assert.equal(result.percent, 100);
});

test('stops progress at blocked or budget exceeded states', () => {
  assert.equal(calculateProgress({ workflow: workflow({ status: 'failed' }), now: 2_000 }).stopReason, 'Blocked');
  assert.equal(calculateProgress({ workflow: workflow({ runCount: 3 }), now: 2_000 }).stopReason, 'Budget Exceeded');
});
