'use strict';

const DEFAULT_BUDGET = Object.freeze({
  maxIterations: 3,
  maxRuntime: 1_800_000,
  supervisorCostLimit: 0,
});

const STOP_REASONS = Object.freeze([
  'DoD Complete',
  'Need Human',
  'Blocked',
  'Stagnation',
  'Regression',
  'Budget Exceeded',
  'Delivery Unverified',
  'Identity Unverified',
  'User Stop',
]);

function contractError(message) {
  return new TypeError('Invalid run contract: ' + message);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function normalizeText(value, field, maxLength) {
  if (typeof value !== 'string') throw contractError(field + ' must be a string');
  const normalized = value.trim();
  if (!normalized) throw contractError(field + ' must be non-empty');
  if (normalized.length > maxLength) throw contractError(field + ' is too long');
  return normalized;
}

function normalizeList(value, field, { required = false } = {}) {
  if (value === undefined) {
    if (required) throw contractError(field + ' (DoD) must contain at least one item');
    return [];
  }
  if (!Array.isArray(value)) throw contractError(field + ' must be an array');
  if (value.length > 100) throw contractError(field + ' has too many items');
  const normalized = [];
  const seen = new Set();
  for (const item of value) {
    const text = normalizeText(item, field + ' item', 2_000);
    if (!seen.has(text)) {
      seen.add(text);
      normalized.push(text);
    }
  }
  if (required && !normalized.length) throw contractError(field + ' (DoD) must contain at least one item');
  return normalized;
}

function normalizeObject(value, field) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw contractError(field + ' must be an object');
  }
  return value;
}

function normalizeBudget(value) {
  const input = normalizeObject(value, 'budget');
  const budget = { ...DEFAULT_BUDGET, ...input };
  if (!Number.isInteger(budget.maxIterations) || budget.maxIterations < 1 || budget.maxIterations > 100) {
    throw contractError('budget.maxIterations must be an integer from 1 to 100');
  }
  if (!Number.isInteger(budget.maxRuntime) || budget.maxRuntime < 1_000 || budget.maxRuntime > 86_400_000) {
    throw contractError('budget.maxRuntime must be an integer from 1000 to 86400000');
  }
  if (typeof budget.supervisorCostLimit !== 'number'
    || !Number.isFinite(budget.supervisorCostLimit)
    || budget.supervisorCostLimit < 0) {
    throw contractError('budget.supervisorCostLimit must be a non-negative number');
  }
  return budget;
}

function normalizeRunContract(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw contractError('input must be an object');
  }
  const autopilotMode = input.autopilotMode === undefined ? 'suggest' : String(input.autopilotMode).trim();
  if (autopilotMode !== 'suggest' && autopilotMode !== 'auto') {
    throw contractError('autopilotMode must be suggest or auto');
  }

  const goal = normalizeText(input.goal, 'goal', 20_000);
  const scopeInput = normalizeObject(input.scope, 'scope');
  const verifyInput = normalizeObject(input.verify, 'verify');
  const inScope = normalizeList(scopeInput.inScope, 'scope.inScope');
  const outOfScope = normalizeList(scopeInput.outOfScope, 'scope.outOfScope');
  const dod = normalizeList(verifyInput.dod, 'verify.dod', { required: true });
  const evidence = normalizeList(verifyInput.evidence, 'verify.evidence');

  return deepFreeze({
    version: 1,
    autopilotMode,
    goal,
    scope: { inScope, outOfScope },
    verify: { dod, evidence: evidence.length ? evidence : [...dod] },
    budget: normalizeBudget(input.budget),
    stop: [...STOP_REASONS],
  });
}

module.exports = { DEFAULT_BUDGET, STOP_REASONS, normalizeRunContract };
