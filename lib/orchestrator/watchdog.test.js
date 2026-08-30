'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { checkWatchdog, fingerprintInstruction } = require('./watchdog');

function workflow(fields = {}) {
  return {
    runContract: { budget: { maxIterations: 3, maxRuntime: 60_000, supervisorCostLimit: 10 } },
    runCount: 0, startedAt: 1_000, updatedAt: 1_000,
    consecutiveFailures: 0, stagnationCount: 0, dispatchFailures: 0,
    lastInstructionFingerprint: '', supervisorCostUsed: 0,
    ...fields,
  };
}

test('watchdog allows a bounded first dispatch and fingerprints instructions', () => {
  const result = checkWatchdog({ workflow: workflow(), instruction: '继续检查 DoD', now: 2_000 });
  assert.equal(result.allowed, true);
  assert.match(fingerprintInstruction('  继续检查   DoD '), /^[a-f0-9]{64}$/);
});

test('watchdog blocks budget, duplicate, failure, stagnation, and cost limits', () => {
  assert.equal(checkWatchdog({ workflow: workflow({ runCount: 3 }), instruction: 'x', now: 2_000 }).reason, 'Budget Exceeded');
  assert.equal(checkWatchdog({ workflow: workflow({ lastInstructionFingerprint: fingerprintInstruction('x') }), instruction: 'x', now: 2_000 }).reason, 'Duplicate Instruction');
  assert.equal(checkWatchdog({ workflow: workflow({ consecutiveFailures: 3 }), instruction: 'x', now: 2_000 }).reason, 'Blocked');
  assert.equal(checkWatchdog({ workflow: workflow({ stagnationCount: 2 }), instruction: 'x', now: 2_000 }).reason, 'Stagnation');
  assert.equal(checkWatchdog({ workflow: workflow({ supervisorCostUsed: 11 }), instruction: 'x', now: 2_000 }).reason, 'Budget Exceeded');
});
