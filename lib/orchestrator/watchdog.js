'use strict';

const crypto = require('node:crypto');

const MAX_FAILURES = 3;
const MAX_STAGNATION = 2;

function fingerprintInstruction(value) {
  return crypto.createHash('sha256').update(String(value || '').trim(), 'utf8').digest('hex');
}

function checkWatchdog({ workflow, instruction = '', now = Date.now() } = {}) {
  if (!workflow || typeof workflow !== 'object') throw new TypeError('workflow is required');
  const budget = workflow.runContract && workflow.runContract.budget || {};
  const runCount = Number.isInteger(workflow.runCount) ? workflow.runCount : 0;
  const startedAt = Number(workflow.startedAt || workflow.createdAt);
  const elapsed = Number.isFinite(startedAt) && Number.isFinite(now) ? Math.max(0, now - startedAt) : 0;
  const fingerprint = fingerprintInstruction(instruction);
  const checks = [
    { name: 'iterations', allowed: runCount < Number(budget.maxIterations), reason: 'Budget Exceeded' },
    { name: 'runtime', allowed: !runCount || elapsed < Number(budget.maxRuntime), reason: 'Budget Exceeded' },
    { name: 'supervisor_cost', allowed: !Number(budget.supervisorCostLimit) || Number(workflow.supervisorCostUsed || 0) < Number(budget.supervisorCostLimit), reason: 'Budget Exceeded' },
    { name: 'failures', allowed: Number(workflow.consecutiveFailures || 0) < MAX_FAILURES, reason: 'Blocked' },
    { name: 'dispatch_failures', allowed: Number(workflow.dispatchFailures || 0) < MAX_FAILURES, reason: 'Blocked' },
    { name: 'stagnation', allowed: Number(workflow.stagnationCount || 0) < MAX_STAGNATION, reason: 'Stagnation' },
    { name: 'duplicate', allowed: !fingerprint || fingerprint !== workflow.lastInstructionFingerprint, reason: 'Duplicate Instruction' },
  ];
  const failed = checks.find((item) => !item.allowed);
  return {
    allowed: !failed,
    reason: failed ? failed.reason : null,
    reasonCode: failed ? (failed.reason === 'Duplicate Instruction' ? 'DUPLICATE_INSTRUCTION' : 'WATCHDOG_BLOCKED') : null,
    fingerprint,
    checks,
  };
}

module.exports = { MAX_FAILURES, MAX_STAGNATION, checkWatchdog, fingerprintInstruction };
