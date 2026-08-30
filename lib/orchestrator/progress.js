'use strict';

function progressError(message) {
  return new TypeError('Invalid workflow progress: ' + message);
}

function safeText(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  return value.trim().slice(0, 2_000);
}

function normalizeEvidence(value, total) {
  if (!Array.isArray(value)) return [];
  const byDod = new Map();
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    if (!Number.isInteger(item.dodIndex) || item.dodIndex < 0 || item.dodIndex >= total) continue;
    if (typeof item.passed !== 'boolean') continue;
    const summary = safeText(item.summary);
    const source = safeText(item.source);
    if (!summary || !source) continue;
    byDod.set(item.dodIndex, {
      dodIndex: item.dodIndex,
      passed: item.passed,
      summary,
      source,
    });
  }
  return [...byDod.values()].sort((left, right) => left.dodIndex - right.dodIndex);
}

function calculateProgress({ workflow, now = Date.now() } = {}) {
  if (!workflow || typeof workflow !== 'object') throw progressError('workflow is required');
  const contract = workflow.runContract;
  const dod = contract && contract.verify && contract.verify.dod;
  if (!Array.isArray(dod) || !dod.length) throw progressError('runContract.verify.dod is required');

  const evidence = normalizeEvidence(workflow.observedEvidence, dod.length);
  const completed = evidence.filter((item) => item.passed).length;
  const total = dod.length;
  const percent = Math.round((completed / total) * 100);
  const budget = contract.budget || {};
  const runCount = Number.isInteger(workflow.runCount) ? workflow.runCount : 0;
  const createdAt = Number(workflow.createdAt);
  const elapsed = Number.isFinite(createdAt) && Number.isFinite(now) ? now - createdAt : 0;
  const budgetExceeded = runCount >= Number(budget.maxIterations)
    || (runCount > 0 && elapsed >= Number(budget.maxRuntime));

  let status = 'not_started';
  let stopReason = null;
  if (completed === total) {
    status = 'completed';
  } else if (budgetExceeded) {
    status = 'blocked';
    stopReason = 'Budget Exceeded';
  } else if (workflow.controlOwner === 'human') {
    status = 'blocked';
    stopReason = 'Need Human';
  } else if (workflow.status === 'failed') {
    status = 'blocked';
    stopReason = 'Blocked';
  } else if (workflow.status === 'waiting_user' || workflow.status === 'completed') {
    status = 'blocked';
    stopReason = 'Need Human';
  } else if (evidence.length || workflow.lastResult || ['running', 'verifying'].includes(workflow.status)) {
    status = 'in_progress';
  }

  return { status, completed, total, percent, evidence, stopReason };
}

module.exports = { calculateProgress, normalizeEvidence };
