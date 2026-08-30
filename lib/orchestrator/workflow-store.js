'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { normalizeRunContract } = require('./run-contract');
const { autoStateForStatus, statusForAutoState, assertAutoTransition, AUTO_STATES } = require('./fsm');
const { normalizeEvidence } = require('./progress');

const TRANSITIONS = {
  draft: new Set(['queued', 'paused']),
  queued: new Set(['running', 'paused']),
  running: new Set(['waiting_user', 'verifying', 'failed', 'paused']),
  waiting_user: new Set(['running', 'paused', 'failed']),
  verifying: new Set(['completed', 'failed', 'paused']),
  completed: new Set(),
  failed: new Set(['queued', 'paused']),
  paused: new Set(['queued', 'running']),
};

function defaultPath() {
  return path.join(os.homedir(), 'AppData', 'Local', 'AgentBoard', 'workflows.json');
}

function legacyRunContract(workflow) {
  const goal = workflow && workflow.executionPlan && workflow.executionPlan.goal;
  return normalizeRunContract({
    goal: typeof goal === 'string' && goal.trim() ? goal : '完成用户目标',
    verify: { dod: ['完成用户目标'] },
  });
}

function normalizeRoutingSummary(summary) {
  if (!summary || typeof summary !== 'object') return null;
  return {
    enabled: summary.enabled === true,
    action: String(summary.action || '').slice(0, 30),
    reasonCode: String(summary.reasonCode || '').slice(0, 80),
    complexityTier: String(summary.complexityTier || '').slice(0, 10),
    thinkingTier: String(summary.thinkingTier || '').slice(0, 10),
    promptPolicy: String(summary.promptPolicy || '').slice(0, 10),
    modelId: String(summary.modelId || '').slice(0, 200),
    reasoningLevel: String(summary.reasoningLevel || '').slice(0, 30),
    source: String(summary.source || '').slice(0, 40),
    verified: summary.verified === true,
    fallbackApplied: summary.fallbackApplied === true,
    catalogSource: String(summary.catalogSource || '').slice(0, 40),
    catalogStale: summary.catalogStale === true,
  };
}

function normalizeLoadedWorkflow(workflow) {
  const normalized = { ...workflow };
  if (!normalized.autopilotMode) normalized.autopilotMode = 'suggest';
  try {
    normalized.runContract = normalized.runContract
      ? normalizeRunContract(normalized.runContract)
      : legacyRunContract(normalized);
  } catch {
    normalized.runContract = legacyRunContract(normalized);
  }
  normalized.autopilotMode = normalized.runContract.autopilotMode;
  normalized.autoState = AUTO_STATES.includes(normalized.autoState)
    ? normalized.autoState : autoStateForStatus(normalized.status);
  if (!Array.isArray(normalized.observedEvidence)) normalized.observedEvidence = [];
  if (!Object.prototype.hasOwnProperty.call(normalized, 'lastSuggestion')) normalized.lastSuggestion = null;
  if (!Object.prototype.hasOwnProperty.call(normalized, 'progress')) normalized.progress = null;
  if (!Object.prototype.hasOwnProperty.call(normalized, 'lastReceipt')) normalized.lastReceipt = null;
  if (!Object.prototype.hasOwnProperty.call(normalized, 'binding')) normalized.binding = null;
  if (!Object.prototype.hasOwnProperty.call(normalized, 'runReceipt')) normalized.runReceipt = null;
  if (!Object.prototype.hasOwnProperty.call(normalized, 'lastDecision')) normalized.lastDecision = null;
  if (!Object.prototype.hasOwnProperty.call(normalized, 'lastTurnContract')) normalized.lastTurnContract = null;
  if (!normalized.routingConfig || typeof normalized.routingConfig !== 'object' || Array.isArray(normalized.routingConfig)) {
    normalized.routingConfig = { enabled: false, preset: 'balanced', manualPin: null, showDetails: true };
  }
  if (!Object.prototype.hasOwnProperty.call(normalized, 'lastRouting')) normalized.lastRouting = null;
  if (!Array.isArray(normalized.routingAudit)) normalized.routingAudit = [];
  if (!Object.prototype.hasOwnProperty.call(normalized, 'lastInstructionFingerprint')) normalized.lastInstructionFingerprint = '';
  if (!Number.isInteger(normalized.iteration)) normalized.iteration = Number.isInteger(normalized.runCount) ? normalized.runCount : 0;
  if (!Number.isInteger(normalized.stagnationCount)) normalized.stagnationCount = 0;
  if (!Number.isInteger(normalized.consecutiveFailures)) normalized.consecutiveFailures = 0;
  if (!Number.isInteger(normalized.dispatchFailures)) normalized.dispatchFailures = 0;
  if (!Number.isFinite(normalized.supervisorCostUsed)) normalized.supervisorCostUsed = 0;
  if (!Number.isInteger(normalized.routingEscalations)) normalized.routingEscalations = 0;
  if (!Number.isInteger(normalized.routingDowngrades)) normalized.routingDowngrades = 0;
  if (!Object.prototype.hasOwnProperty.call(normalized, 'stopReason')) normalized.stopReason = null;
  if (!Object.prototype.hasOwnProperty.call(normalized, 'startedAt')) normalized.startedAt = null;
  if (!Object.prototype.hasOwnProperty.call(normalized, 'endedAt')) normalized.endedAt = null;
  return normalized;
}

class WorkflowStore {
  constructor(filePath = defaultPath()) {
    this.filePath = filePath;
    this.data = { workflows: [], events: [], wal: [], dispatchRecords: [] };
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (raw && Array.isArray(raw.workflows) && Array.isArray(raw.events)) {
        this.data = {
          workflows: raw.workflows.map(normalizeLoadedWorkflow),
          events: raw.events,
          wal: Array.isArray(raw.wal) ? raw.wal : [],
          dispatchRecords: Array.isArray(raw.dispatchRecords) ? raw.dispatchRecords : [],
        };
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  save() {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tempPath = this.filePath + '.tmp';
    fs.writeFileSync(tempPath, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(tempPath, this.filePath);
  }

  emit(type, workflow) {
    this.data.events.push({ id: crypto.randomUUID(), type, workflowId: workflow.id, at: Date.now() });
  }

  create({
    projectPath,
    mode = 'project',
    agent = '',
    classification = null,
    executionPlan = null,
    requestedBy = 'human',
    autopilotMode = 'suggest',
    runContract = null,
    binding = null,
  }) {
    const contract = runContract || normalizeRunContract({
      autopilotMode,
      goal: executionPlan && executionPlan.goal ? executionPlan.goal : '完成用户目标',
      verify: { dod: ['完成用户目标'] },
    });
    const workflow = {
      id: 'wf-' + crypto.randomUUID(), projectPath: String(projectPath), mode, agent: String(agent),
      requestedBy: String(requestedBy), classification, executionPlan,
      autopilotMode: contract.autopilotMode, runContract: normalizeRunContract(contract),
      binding: binding ? {
        sessionRef: String(binding.sessionRef || '').trim(),
        agent: String(binding.agent || agent || '').trim(),
        projectPath: String(binding.projectPath || projectPath || '').trim(),
      } : null,
      observedEvidence: [], lastSuggestion: null, progress: null, lastReceipt: null,
      runReceipt: null, lastDecision: null, lastTurnContract: null, lastInstructionFingerprint: '',
      routingConfig: { enabled: false, preset: 'balanced', manualPin: null, showDetails: true },
      lastRouting: null, routingAudit: [],
      autoState: 'OFF', stopReason: null, startedAt: null, endedAt: null,
      iteration: 0, stagnationCount: 0, consecutiveFailures: 0, dispatchFailures: 0,
      supervisorCostUsed: 0, routingEscalations: 0, routingDowngrades: 0,
      status: 'draft', controlOwner: null, leaseExpiresAt: 0, runCount: 0, lastError: '',
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    this.data.workflows.push(workflow);
    this.emit('created', workflow);
    this.save();
    return { ...workflow };
  }

  get(id) {
    const workflow = this.data.workflows.find((item) => item.id === id);
    return workflow ? { ...workflow } : null;
  }

  list() {
    return this.data.workflows.map((workflow) => ({ ...workflow }));
  }

  update(workflow, type) {
    workflow.updatedAt = Date.now();
    this.emit(type, workflow);
    this.save();
    return { ...workflow };
  }

  updateFields(id, fields, type = 'updated') {
    const workflow = this.data.workflows.find((item) => item.id === id);
    if (!workflow) throw new Error('workflow not found');
    Object.assign(workflow, fields || {});
    return this.update(workflow, type);
  }

  incrementRun(id) {
    const workflow = this.data.workflows.find((item) => item.id === id);
    if (!workflow) throw new Error('workflow not found');
    workflow.runCount += 1;
    workflow.iteration = workflow.runCount;
    if (!workflow.startedAt) workflow.startedAt = Date.now();
    return this.update(workflow, 'run_started');
  }

  release(id, owner = '') {
    const workflow = this.data.workflows.find((item) => item.id === id);
    if (!workflow) throw new Error('workflow not found');
    if (owner && workflow.controlOwner && workflow.controlOwner !== owner) {
      throw new Error('workflow is controlled by another owner');
    }
    workflow.controlOwner = null;
    workflow.leaseExpiresAt = 0;
    return this.update(workflow, 'released');
  }

  transition(id, nextStatus) {
    const workflow = this.data.workflows.find((item) => item.id === id);
    if (!workflow) throw new Error('workflow not found');
    if (!TRANSITIONS[workflow.status] || !TRANSITIONS[workflow.status].has(nextStatus)) {
      throw new Error(`illegal workflow transition: ${workflow.status} -> ${nextStatus}`);
    }
    workflow.autoState = autoStateForStatus(nextStatus);
    workflow.status = nextStatus;
    return this.update(workflow, 'transition');
  }

  transitionState(id, nextState, type = 'auto_transition') {
    const workflow = this.data.workflows.find((item) => item.id === id);
    if (!workflow) throw new Error('workflow not found');
    assertAutoTransition(workflow.autoState || autoStateForStatus(workflow.status), nextState);
    workflow.autoState = nextState;
    workflow.status = statusForAutoState(nextState);
    return this.update(workflow, type);
  }

  claim(id, owner, leaseMs = 60_000, now = Date.now()) {
    const workflow = this.data.workflows.find((item) => item.id === id);
    if (!workflow) throw new Error('workflow not found');
    const current = this.data.workflows.find((item) => item.projectPath === workflow.projectPath && item.controlOwner && item.leaseExpiresAt > now);
    if (current && current.id !== id) throw new Error('project is already controlled');
    workflow.controlOwner = String(owner);
    workflow.leaseExpiresAt = now + Number(leaseMs);
    return this.update(workflow, 'claim');
  }

  takeover(id, owner = 'human', now = Date.now()) {
    const workflow = this.data.workflows.find((item) => item.id === id);
    if (!workflow) throw new Error('workflow not found');
    workflow.controlOwner = String(owner);
    workflow.leaseExpiresAt = 0;
    if (workflow.status !== 'paused' && workflow.status !== 'completed') {
      workflow.autoState = 'PAUSED';
      workflow.status = 'paused';
      workflow.stopReason = 'Need Human';
    }
    return this.update(workflow, 'takeover');
  }

  recordEvidence(id, evidence) {
    const workflow = this.data.workflows.find((item) => item.id === id);
    if (!workflow) throw new Error('workflow not found');
    const total = workflow.runContract.verify.dod.length;
    const observedEvidence = normalizeEvidence([...workflow.observedEvidence, evidence], total);
    return this.updateFields(id, { observedEvidence }, 'evidence_observed');
  }

  recordRouting(id, { summary = null, auditEvent = null } = {}) {
    const workflow = this.data.workflows.find((item) => item.id === id);
    if (!workflow) throw new Error('workflow not found');
    const safeSummary = normalizeRoutingSummary(summary);
    const routingAudit = Array.isArray(workflow.routingAudit) ? [...workflow.routingAudit] : [];
    if (auditEvent && typeof auditEvent === 'object') routingAudit.push({ ...auditEvent });
    const fields = { lastRouting: safeSummary, routingAudit: routingAudit.slice(-100) };
    if (safeSummary && safeSummary.reasonCode === 'ROUTE_ESCALATED') {
      fields.routingEscalations = Number(workflow.routingEscalations || 0) + 1;
    }
    if (safeSummary && safeSummary.reasonCode === 'ROUTE_DOWNGRADED') {
      fields.routingDowngrades = Number(workflow.routingDowngrades || 0) + 1;
    }
    return this.updateFields(id, fields, 'routing_recorded');
  }

  appendWal(workflowId, entry = {}) {
    if (!this.data.workflows.some((workflow) => workflow.id === workflowId)) throw new Error('workflow not found');
    const state = String(entry.state || 'pending');
    if (!['pending', 'committed', 'reconcile_required'].includes(state)) throw new TypeError('invalid WAL state');
    const record = {
      id: 'wal-' + crypto.randomUUID(), operationId: String(entry.operationId || crypto.randomUUID()), workflowId,
      state, phase: String(entry.phase || ''), sendAttempted: entry.sendAttempted === true,
      instructionFingerprint: String(entry.instructionFingerprint || '').slice(0, 128),
      instruction: typeof entry.instruction === 'string' ? entry.instruction.slice(0, 200_000) : '',
      reason: typeof entry.reason === 'string' ? entry.reason.slice(0, 2_000) : '',
      at: Date.now(),
    };
    this.data.wal.push(record);
    this.emitEvent('wal_' + state, workflowId);
    this.save();
    return { ...record };
  }

  listWal(workflowId) {
    return this.data.wal.filter((entry) => !workflowId || entry.workflowId === workflowId).map((entry) => ({ ...entry }));
  }

  listPendingWal(workflowId) {
    const latest = new Map();
    for (const entry of this.data.wal) {
      if (workflowId && entry.workflowId !== workflowId) continue;
      latest.set(`${entry.workflowId}:${entry.operationId}`, entry);
    }
    return [...latest.values()].filter((entry) => entry.state === 'pending').map((entry) => ({ ...entry }));
  }

  appendDispatchRecord(workflowId, record = {}) {
    if (!this.data.workflows.some((workflow) => workflow.id === workflowId)) throw new Error('workflow not found');
    const safe = {
      id: 'dispatch-' + crypto.randomUUID(), workflowId, attempt: Number(record.attempt || 0), state: String(record.state || ''),
      instructionFingerprint: String(record.instructionFingerprint || '').slice(0, 128), turnContract: record.turnContract || null,
      phase: String(record.phase || ''), failureReasonCode: String(record.failureReasonCode || ''),
      routing: normalizeRoutingSummary(record.routing),
      sessionRef: String(record.sessionRef || ''), at: Date.now(),
    };
    this.data.dispatchRecords.push(safe);
    this.emitEvent('dispatch_recorded', workflowId);
    this.save();
    return { ...safe };
  }

  listDispatchRecords(workflowId) {
    return this.data.dispatchRecords.filter((record) => !workflowId || record.workflowId === workflowId).map((record) => ({ ...record }));
  }

  emitEvent(type, workflowId) {
    this.data.events.push({ id: crypto.randomUUID(), type, workflowId, at: Date.now() });
  }
}

module.exports = { TRANSITIONS, WorkflowStore };
