'use strict';

const { normalizeResearchState } = require('./researcher');

const DEFAULT_BUDGET = Object.freeze({
  maxIterations: 3,
  maxRuntime: 1_800_000,
  maxBudget: 0,
  stagnationThreshold: 2,
  failureThreshold: 3,
  supervisorCostLimit: 0,
});

const HANDOFF_STEP_STATUSES = Object.freeze([
  'pending', 'ready', 'running', 'waiting_agent', 'done', 'paused', 'need_human', 'failed', 'blocked',
]);

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

function redactSensitiveText(value) {
  return String(value || '').replace(/((?:api[_ -]?key|authorization|bearer|oauth[_ -]?token|access[_ -]?token|refresh[_ -]?token|token|cookie|password|passwd|private[_ -]?key|prompt)\s*(?:=|:)\s*(?:bearer\s+)?)[^\s,;]+/gi, '$1[REDACTED]');
}

function normalizeList(value, field, { required = false, redact = false } = {}) {
  if (value === undefined) {
    if (required) throw contractError(field + ' (DoD) must contain at least one item');
    return [];
  }
  if (!Array.isArray(value)) throw contractError(field + ' must be an array');
  if (value.length > 100) throw contractError(field + ' has too many items');
  const normalized = [];
  const seen = new Set();
  for (const item of value) {
    const itemText = normalizeText(item, field + ' item', 2_000);
    const safeText = redact ? redactSensitiveText(itemText) : itemText;
    if (!seen.has(safeText)) {
      seen.add(safeText);
      normalized.push(safeText);
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
  if (typeof budget.maxBudget !== 'number' || !Number.isFinite(budget.maxBudget) || budget.maxBudget < 0) {
    throw contractError('budget.maxBudget must be a non-negative number');
  }
  for (const field of ['stagnationThreshold', 'failureThreshold']) {
    if (!Number.isInteger(budget[field]) || budget[field] < 1 || budget[field] > 20) {
      throw contractError(`budget.${field} must be an integer from 1 to 20`);
    }
  }
  if (typeof budget.supervisorCostLimit !== 'number'
    || !Number.isFinite(budget.supervisorCostLimit)
    || budget.supervisorCostLimit < 0) {
    throw contractError('budget.supervisorCostLimit must be a non-negative number');
  }
  const normalized = { ...budget };
  if (Object.prototype.hasOwnProperty.call(input, 'maxStepRuntime')) {
    if (!Number.isInteger(input.maxStepRuntime) || input.maxStepRuntime < 1_000 || input.maxStepRuntime > 86_400_000) {
      throw contractError('budget.maxStepRuntime must be an integer from 1000 to 86400000');
    }
    normalized.maxStepRuntime = input.maxStepRuntime;
  } else {
    delete normalized.maxStepRuntime;
  }
  if (Object.prototype.hasOwnProperty.call(input, 'maxRetries')) {
    if (!Number.isInteger(input.maxRetries) || input.maxRetries < 0 || input.maxRetries > 20) {
      throw contractError('budget.maxRetries must be an integer from 0 to 20');
    }
    normalized.maxRetries = input.maxRetries;
  } else {
    delete normalized.maxRetries;
  }
  return normalized;
}

function normalizeSafeStepResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result = {};
  for (const field of ['status', 'code', 'reason', 'summary']) {
    if (typeof value[field] === 'string' && value[field].trim()) result[field] = redactSensitiveText(value[field].trim()).slice(0, 1_000);
  }
  return Object.keys(result).length ? result : null;
}

function normalizeStepEvidenceSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const snapshot = {};
  for (const field of ['verified', 'completed', 'deliveryVerified']) {
    if (typeof value[field] === 'boolean') snapshot[field] = value[field];
  }
  for (const field of ['passed', 'total', 'completedCount']) {
    if (Number.isInteger(value[field]) && value[field] >= 0) snapshot[field] = value[field];
  }
  if (typeof value.source === 'string' && value.source.trim()) snapshot.source = redactSensitiveText(value.source.trim()).slice(0, 200);
  return Object.keys(snapshot).length ? snapshot : null;
}

function normalizeHandoffChain(value) {
  if (!Array.isArray(value)) throw contractError('handoffChain must be an array');
  if (value.length > 32) throw contractError('handoffChain has too many steps');
  const ids = new Set();
  const orders = new Set();
  const steps = value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw contractError(`handoffChain[${index}] must be an object`);
    const id = normalizeText(item.id, `handoffChain[${index}].id`, 100);
    if (ids.has(id)) throw contractError(`handoffChain duplicate id: ${id}`);
    ids.add(id);
    const order = item.order === undefined ? index + 1 : item.order;
    if (!Number.isInteger(order) || order < 1 || order > 1000 || orders.has(order)) {
      throw contractError(`handoffChain[${index}].order must be a unique positive integer`);
    }
    orders.add(order);
    const agent = normalizeText(item.agent, `handoffChain[${index}].agent`, 40).toLowerCase();
    if (!/^[a-z][a-z0-9_-]{0,39}$/.test(agent)) throw contractError(`handoffChain[${index}].agent is invalid`);
    const goal = redactSensitiveText(normalizeText(item.goal, `handoffChain[${index}].goal`, 20_000));
    const dod = normalizeList(item.dod, `handoffChain[${index}].dod`, { required: true, redact: true });
    const evidence = normalizeList(item.evidence, `handoffChain[${index}].evidence`, { redact: true });
    const dependsOn = normalizeList(item.dependsOn, `handoffChain[${index}].dependsOn`);
    const status = item.status === undefined ? 'pending' : String(item.status).trim();
    if (!HANDOFF_STEP_STATUSES.includes(status)) throw contractError(`handoffChain[${index}].status is invalid`);
    const attempts = item.attempts === undefined ? 0 : item.attempts;
    if (!Number.isInteger(attempts) || attempts < 0 || attempts > 100) throw contractError(`handoffChain[${index}].attempts is invalid`);
    const rawSessionRef = item.sessionRef === undefined ? '' : String(item.sessionRef).trim();
    if (rawSessionRef && /[\r\n\t]/.test(rawSessionRef)) throw contractError(`handoffChain[${index}].sessionRef is invalid`);
    const sessionRef = rawSessionRef.slice(0, 300);
    const startedAt = item.startedAt === undefined ? null : item.startedAt;
    const completedAt = item.completedAt === undefined ? null : item.completedAt;
    for (const [field, timestamp] of [['startedAt', startedAt], ['completedAt', completedAt]]) {
      if (timestamp !== null && (!Number.isFinite(timestamp) || timestamp < 0)) throw contractError(`handoffChain[${index}].${field} is invalid`);
    }
    const result = normalizeSafeStepResult(item.result);
    const evidenceSnapshot = normalizeStepEvidenceSnapshot(item.evidenceSnapshot);
    const researchState = Object.prototype.hasOwnProperty.call(item, 'researchState')
      ? normalizeResearchState(item.researchState) : normalizeResearchState({ status: 'completed', confidence: 1 });
    if (status === 'done' && (!evidenceSnapshot || evidenceSnapshot.verified !== true || evidenceSnapshot.completed !== true)) {
      throw contractError(`handoffChain[${index}] DONE requires verified evidence`);
    }
    return {
      id, order, agent, goal, dod, evidence, dependsOn, status, sessionRef, attempts,
      startedAt, completedAt, result, evidenceSnapshot, researchState,
    };
  }).sort((left, right) => left.order - right.order);
  const idsAfterSort = new Set(steps.map((step) => step.id));
  for (const step of steps) {
    for (const dependency of step.dependsOn) {
      if (!idsAfterSort.has(dependency)) throw contractError(`handoffChain dependency not found: ${dependency}`);
      if (dependency === step.id) throw contractError(`handoffChain step cannot depend on itself: ${step.id}`);
      if (byOrder(steps, dependency).order >= step.order) throw contractError(`handoffChain dependency must precede step: ${dependency}`);
    }
  }
  const visiting = new Set();
  const visited = new Set();
  const byId = new Map(steps.map((step) => [step.id, step]));
  function visit(id) {
    if (visiting.has(id)) throw contractError('handoffChain dependencies contain a cycle');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id).dependsOn) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  }
  for (const step of steps) visit(step.id);
  return steps;
}

function byOrder(steps, id) {
  return steps.find((step) => step.id === id) || { order: Number.POSITIVE_INFINITY };
}

function normalizeRunContract(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw contractError('input must be an object');
  }
  const autopilotMode = input.autopilotMode === undefined ? 'suggest' : String(input.autopilotMode).trim();
  if (!['suggest', 'auto', 'guarded'].includes(autopilotMode)) {
    throw contractError('autopilotMode must be suggest or auto (or guarded)');
  }

  const goal = normalizeText(input.goal, 'goal', 20_000);
  const goalSummary = input.goalSummary === undefined
    || (typeof input.goalSummary === 'string' && !input.goalSummary.trim())
    ? goal : normalizeText(input.goalSummary, 'goalSummary', 2_000);
  const scopeInput = normalizeObject(input.scope, 'scope');
  const verifyInput = normalizeObject(input.verify, 'verify');
  const inScope = normalizeList(scopeInput.inScope, 'scope.inScope');
  const outOfScope = normalizeList(scopeInput.outOfScope, 'scope.outOfScope');
  const dod = normalizeList(verifyInput.dod, 'verify.dod', { required: true });
  const evidence = normalizeList(verifyInput.evidence, 'verify.evidence');

  const contract = {
    version: 1,
    autopilotMode,
    goal,
    goalSummary,
    scope: { inScope, outOfScope },
    verify: { dod, evidence: evidence.length ? evidence : [...dod] },
    budget: normalizeBudget(input.budget),
    stop: [...STOP_REASONS],
    ...(Object.prototype.hasOwnProperty.call(input, 'handoffChain') ? { handoffChain: normalizeHandoffChain(input.handoffChain) } : {}),
  };
  return deepFreeze(contract);
}

module.exports = { DEFAULT_BUDGET, HANDOFF_STEP_STATUSES, STOP_REASONS, normalizeHandoffChain, normalizeRunContract };
