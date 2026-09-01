'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { normalizeRunContract } = require('./run-contract');
const { autoStateForStatus, statusForAutoState, assertAutoTransition, AUTO_STATES } = require('./fsm');
const { normalizeEvidence } = require('./progress');
const { normalizeRoutingAuditEvent } = require('./routing/audit');
const { normalizeSettingsSnapshot } = require('./settings-store');
const { normalizeTaskContract } = require('./task-intake');
const { buildPermissionSnapshot, normalizePermissionSnapshot } = require('./permission-snapshot');

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

function safeText(value, max = 200) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function safeCode(value, max = 80) {
  return safeText(value, max).toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, max);
}

function deepClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function safeRouteRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return null;
  return {
    complexityTier: safeText(request.complexityTier, 10),
    thinkingTier: safeText(request.thinkingTier, 10),
    promptPolicy: safeText(request.promptPolicy, 10),
  };
}

function safeResolvedProfile(profile) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return null;
  const safe = {
    modelId: safeText(profile.modelId, 200),
    reasoningLevel: safeText(profile.reasoningLevel, 30).toLowerCase(),
  };
  return safe.modelId ? safe : null;
}

function safeVerification(verification) {
  if (!verification || typeof verification !== 'object' || Array.isArray(verification)) return { verified: false };
  const result = { verified: verification.verified === true };
  const source = safeText(verification.source, 40);
  const resultCode = safeCode(verification.resultCode || verification.code, 80);
  if (source) result.source = source;
  if (resultCode) result.resultCode = resultCode;
  return result;
}

function safeProof(proof, kind = 'generic') {
  if (!proof || typeof proof !== 'object' || Array.isArray(proof)) return null;
  const result = {};
  for (const field of kind === 'identity' ? ['verified', 'strongAnchor'] : kind === 'delivery' ? ['verified', 'delivered'] : ['verified']) {
    if (typeof proof[field] === 'boolean') result[field] = proof[field];
  }
  if ((kind === 'identity' || kind === 'delivery') && !Object.prototype.hasOwnProperty.call(result, 'verified')
    && typeof proof.ok === 'boolean') result.verified = proof.ok;
  const source = safeText(proof.source, 40);
  const resultCode = safeCode(proof.resultCode || proof.code, 80);
  const fingerprint = safeText(proof.fingerprint, 128);
  if (source) result.source = source;
  if (resultCode) result.resultCode = resultCode;
  if (fingerprint) result.fingerprint = fingerprint;
  const anchor = safeText(proof.anchor || proof.anchorId, 200);
  if (anchor) result.anchorFingerprint = crypto.createHash('sha256').update(anchor, 'utf8').digest('hex').slice(0, 32);
  const proofId = safeText(proof.messageId || proof.deliveryId || proof.eventId || proof.sourceId, 200);
  if (proofId) result.proofIdFingerprint = crypto.createHash('sha256').update(proofId, 'utf8').digest('hex').slice(0, 32);
  const sequence = proof.sequence ?? proof.seq ?? proof.sessionSeq ?? proof.session_seq;
  if (Number.isInteger(sequence) && sequence >= 0) result.sequence = sequence;
  return Object.keys(result).length ? result : null;
}

function safeSequence(value) {
  if (Number.isInteger(value) && value >= 0) return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const sequence = value.sessionSeqBefore ?? value.session_seq_before ?? value.seqBefore ?? value.sequence ?? value.seq;
  return Number.isInteger(sequence) && sequence >= 0 ? sequence : null;
}

function safeTimestamp(value) {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function safeDeliverySnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
  const result = {};
  for (const field of ['agent', 'threadId', 'sessionId']) {
    const value = safeText(snapshot[field], 200);
    if (value) result[field] = value;
  }
  for (const field of ['filePath', 'dbPath']) {
    const value = safeText(snapshot[field], 2_000);
    if (value) result[field] = value;
  }
  for (const [output, input] of [
    ['byteOffset', 'byteOffset'], ['size', 'size'], ['lastMessageId', 'lastMessageId'], ['capturedAt', 'capturedAt'],
  ]) {
    if (Number.isInteger(snapshot[input]) && (output === 'lastMessageId' ? snapshot[input] >= -1 : snapshot[input] >= 0)) result[output] = snapshot[input];
    else if (output === 'capturedAt' && safeTimestamp(snapshot[input]) !== null) result[output] = snapshot[input];
  }
  const sessionSeqBefore = safeSequence(snapshot.sessionSeqBefore ?? snapshot.session_seq_before);
  if (sessionSeqBefore !== null) result.sessionSeqBefore = sessionSeqBefore;
  return Object.keys(result).length ? result : null;
}

function normalizeAcceptedTurnSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
  const turnId = safeText(snapshot.turnId, 100);
  const attempt = Number.isInteger(snapshot.attempt) && snapshot.attempt >= 0 ? snapshot.attempt : 0;
  const routeRequest = safeRouteRequest(snapshot.routeRequest);
  const resolvedProfile = safeResolvedProfile(snapshot.resolvedProfile);
  const verification = safeVerification(snapshot.verification);
  if (!turnId || !routeRequest || !resolvedProfile || verification.verified !== true) return null;
  return deepFreeze({ turnId, attempt, routeRequest, resolvedProfile, verification });
}

function copyWorkflow(workflow) {
  if (!workflow) return null;
  const copy = { ...workflow };
  if (workflow.acceptedTurnSnapshot) copy.acceptedTurnSnapshot = deepClone(workflow.acceptedTurnSnapshot);
  if (workflow.acceptedTurn) copy.acceptedTurn = deepClone(workflow.acceptedTurn);
  if (workflow.settingsSnapshot) copy.settingsSnapshot = deepClone(workflow.settingsSnapshot);
  if (workflow.permissionSnapshot) copy.permissionSnapshot = deepClone(workflow.permissionSnapshot);
  if (workflow.taskContract) copy.taskContract = deepClone(workflow.taskContract);
  return copy;
}

function safeTurnContract(contract) {
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) return null;
  return {
    action: safeText(contract.action, 50),
    targetDodItems: Array.isArray(contract.targetDodItems) ? contract.targetDodItems.map((item) => safeText(item, 100)).filter(Boolean) : [],
    scope: Array.isArray(contract.scope) ? contract.scope.map((item) => safeText(item, 2_000)).filter(Boolean) : [],
    expectedResult: safeText(contract.expectedResult, 20_000),
  };
}

function normalizeWalRecord(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const state = ['pending', 'committed', 'reconcile_required'].includes(entry.state) ? entry.state : 'reconcile_required';
  return {
    id: safeText(entry.id, 120), operationId: safeText(entry.operationId, 120), workflowId: safeText(entry.workflowId, 120),
    kind: safeText(entry.kind, 30) || (safeText(entry.phase, 60).includes('APPLY') ? 'profile_apply' : 'dispatch'),
    attempt: Number.isInteger(entry.attempt) && entry.attempt >= 0 ? entry.attempt : 0,
    state, phase: safeText(entry.phase, 60), sendAttempted: entry.sendAttempted === true,
    instructionFingerprint: safeText(entry.instructionFingerprint, 128),
    routeRequest: safeRouteRequest(entry.routeRequest), resolvedProfile: safeResolvedProfile(entry.resolvedProfile || entry.profile),
    deliverySnapshot: safeDeliverySnapshot(entry.deliverySnapshot || entry.delivery_snapshot),
    reasonCode: safeCode(entry.reasonCode || entry.failureReasonCode, 80), at: Number.isFinite(entry.at) ? entry.at : 0,
  };
}

function normalizeDispatchRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const acceptedTurn = normalizeAcceptedTurnSnapshot(record.acceptedTurn || record.acceptedTurnSnapshot);
  return {
    id: safeText(record.id, 120), workflowId: safeText(record.workflowId, 120), attempt: Number(record.attempt || 0),
    state: safeText(record.state, 30), instructionFingerprint: safeText(record.instructionFingerprint, 128),
    turnContract: safeTurnContract(record.turnContract),
    routeRequest: safeRouteRequest(record.routeRequest || (acceptedTurn && acceptedTurn.routeRequest)),
    resolvedModel: safeText(record.resolvedModel || (acceptedTurn && acceptedTurn.resolvedProfile.modelId), 200),
    resolvedReasoning: safeText(record.resolvedReasoning || (acceptedTurn && acceptedTurn.resolvedProfile.reasoningLevel), 30).toLowerCase(),
    profileApplyMethod: safeText(record.profileApplyMethod, 40),
    profileVerification: safeVerification(record.profileVerification || (acceptedTurn && acceptedTurn.verification)),
    acceptedTurn: acceptedTurn ? deepClone(acceptedTurn) : null,
    phase: safeText(record.phase, 60), failureReasonCode: safeCode(record.failureReasonCode, 80),
    routing: normalizeRoutingSummary(record.routing), sessionRef: safeText(record.sessionRef, 200),
    sessionSeqBefore: safeSequence(record.sessionSeqBefore ?? record.session_seq_before),
    identityProof: safeProof(record.identityProof || record.identity_proof, 'identity'),
    deliveryProof: safeProof(record.deliveryProof || record.delivery_proof, 'delivery'),
    startedAt: safeTimestamp(record.startedAt ?? record.started_at),
    completedAt: safeTimestamp(record.completedAt ?? record.completed_at),
    at: Number.isFinite(record.at) ? record.at : 0,
  };
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
  if (normalized.settingsSnapshot) {
    try { normalized.settingsSnapshot = normalizeSettingsSnapshot(normalized.settingsSnapshot); } catch { normalized.settingsSnapshot = null; }
  } else {
    normalized.settingsSnapshot = null;
  }
  if (normalized.permissionSnapshot) {
    try { normalized.permissionSnapshot = normalizePermissionSnapshot(normalized.permissionSnapshot); } catch { normalized.permissionSnapshot = { invalid: true }; }
  } else {
    try { normalized.permissionSnapshot = buildPermissionSnapshot({ projectPath: normalized.projectPath }); } catch { normalized.permissionSnapshot = null; }
  }
  if (normalized.taskContract) {
    try { normalized.taskContract = normalizeTaskContract(normalized.taskContract); } catch { normalized.taskContract = null; }
  } else {
    normalized.taskContract = null;
  }
  if (!Object.prototype.hasOwnProperty.call(normalized, 'runReceipt')) normalized.runReceipt = null;
  if (!Object.prototype.hasOwnProperty.call(normalized, 'lastDecision')) normalized.lastDecision = null;
  if (!Object.prototype.hasOwnProperty.call(normalized, 'lastTurnContract')) normalized.lastTurnContract = null;
  if (!Object.prototype.hasOwnProperty.call(normalized, 'lastCompletionDispatchId')) normalized.lastCompletionDispatchId = null;
  const acceptedSnapshot = normalizeAcceptedTurnSnapshot(normalized.acceptedTurnSnapshot || normalized.acceptedTurn);
  normalized.acceptedTurnSnapshot = acceptedSnapshot;
  normalized.acceptedTurn = acceptedSnapshot;
  normalized.profileApplyReconciled = normalized.profileApplyReconciled === true;
  if (!normalized.routingConfig || typeof normalized.routingConfig !== 'object' || Array.isArray(normalized.routingConfig)) {
    normalized.routingConfig = { enabled: false, preset: 'balanced', manualPin: null, showDetails: true };
  }
  if (!Object.prototype.hasOwnProperty.call(normalized, 'lastRouting')) normalized.lastRouting = null;
  normalized.routingAudit = Array.isArray(normalized.routingAudit)
    ? normalized.routingAudit.map((event) => normalizeRoutingAuditEvent(event)).filter(Boolean)
    : [];
  if (!Object.prototype.hasOwnProperty.call(normalized, 'lastInstructionFingerprint')) normalized.lastInstructionFingerprint = '';
  if (!Number.isInteger(normalized.iteration)) normalized.iteration = Number.isInteger(normalized.runCount) ? normalized.runCount : 0;
  if (!Number.isInteger(normalized.stagnationCount)) normalized.stagnationCount = 0;
  if (!Number.isInteger(normalized.consecutiveFailures)) normalized.consecutiveFailures = 0;
  if (!Number.isInteger(normalized.dispatchFailures)) normalized.dispatchFailures = 0;
  if (!Number.isFinite(normalized.supervisorCostUsed)) normalized.supervisorCostUsed = 0;
  if (!Number.isInteger(normalized.routingEscalations)) normalized.routingEscalations = 0;
  if (!Number.isInteger(normalized.routingDowngrades)) normalized.routingDowngrades = 0;
  if (!Number.isInteger(normalized.lastReconciledRunCount) || normalized.lastReconciledRunCount < 0) normalized.lastReconciledRunCount = 0;
  if (!Object.prototype.hasOwnProperty.call(normalized, 'lastReconciledAt')) normalized.lastReconciledAt = null;
  if (!Object.prototype.hasOwnProperty.call(normalized, 'lastReconciliation')) normalized.lastReconciliation = null;
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
          wal: Array.isArray(raw.wal) ? raw.wal.map(normalizeWalRecord).filter(Boolean) : [],
          dispatchRecords: Array.isArray(raw.dispatchRecords) ? raw.dispatchRecords.map(normalizeDispatchRecord).filter(Boolean) : [],
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
    routingConfig = null,
    settingsSnapshot = null,
    taskContract = null,
    permissionSnapshot = null,
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
      settingsSnapshot: settingsSnapshot ? normalizeSettingsSnapshot(settingsSnapshot) : null,
      permissionSnapshot: permissionSnapshot ? normalizePermissionSnapshot(permissionSnapshot) : buildPermissionSnapshot({ projectPath }),
      taskContract: taskContract ? normalizeTaskContract(taskContract) : null,
      binding: binding ? {
        sessionRef: String(binding.sessionRef || '').trim(),
        agent: String(binding.agent || agent || '').trim(),
        projectPath: String(binding.projectPath || projectPath || '').trim(),
        ...(safeText(binding.title, 300) ? { title: safeText(binding.title, 300) } : {}),
        ...(safeText(binding.transport, 60) ? { transport: safeText(binding.transport, 60) } : {}),
      } : null,
      observedEvidence: [], lastSuggestion: null, progress: null, lastReceipt: null,
      runReceipt: null, lastDecision: null, lastTurnContract: null, lastInstructionFingerprint: '',
      lastCompletionDispatchId: null,
      acceptedTurnSnapshot: null, acceptedTurn: null, profileApplyReconciled: false,
      routingConfig: routingConfig && typeof routingConfig === 'object' ? { ...routingConfig } : { enabled: false, preset: 'balanced', manualPin: null, showDetails: true },
      lastRouting: null, routingAudit: [],
      autoState: 'OFF', stopReason: null, startedAt: null, endedAt: null,
      iteration: 0, stagnationCount: 0, consecutiveFailures: 0, dispatchFailures: 0,
      supervisorCostUsed: 0, routingEscalations: 0, routingDowngrades: 0,
      lastReconciledRunCount: 0, lastReconciledAt: null, lastReconciliation: null,
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
    return copyWorkflow(workflow);
  }

  list() {
    return this.data.workflows.map(copyWorkflow);
  }

  listEvents(workflowId) {
    return this.data.events
      .filter((event) => !workflowId || event.workflowId === workflowId)
      .map((event) => ({
        type: safeText(event.type, 60),
        workflowId: safeText(event.workflowId, 120),
        at: Number.isFinite(event.at) ? event.at : 0,
      }))
      .filter((event) => event.type && event.workflowId);
  }

  update(workflow, type) {
    const stored = this.data.workflows.find((item) => item.id === workflow.id);
    if (!stored) throw new Error('workflow not found');
    if (Object.prototype.hasOwnProperty.call(workflow, 'acceptedTurnSnapshot')) {
      const incoming = normalizeAcceptedTurnSnapshot(workflow.acceptedTurnSnapshot);
      if (JSON.stringify(incoming) !== JSON.stringify(stored.acceptedTurnSnapshot)) {
        throw new TypeError('accepted turn snapshot is immutable');
      }
    }
    if (Object.prototype.hasOwnProperty.call(workflow, 'acceptedTurn')) {
      const incoming = normalizeAcceptedTurnSnapshot(workflow.acceptedTurn);
      if (JSON.stringify(incoming) !== JSON.stringify(stored.acceptedTurnSnapshot)) {
        throw new TypeError('accepted turn snapshot is immutable');
      }
    }
    if (Object.prototype.hasOwnProperty.call(workflow, 'settingsSnapshot')) {
      const incoming = workflow.settingsSnapshot ? normalizeSettingsSnapshot(workflow.settingsSnapshot) : null;
      if (JSON.stringify(incoming) !== JSON.stringify(stored.settingsSnapshot)) {
        throw new TypeError('settings snapshot is immutable');
      }
    }
    if (Object.prototype.hasOwnProperty.call(workflow, 'permissionSnapshot')) {
      const incoming = workflow.permissionSnapshot ? normalizePermissionSnapshot(workflow.permissionSnapshot) : null;
      if (JSON.stringify(incoming) !== JSON.stringify(stored.permissionSnapshot)) {
        throw new TypeError('permission snapshot is immutable');
      }
    }
    workflow.updatedAt = Date.now();
    this.emit(type, workflow);
    this.save();
    return copyWorkflow(workflow);
  }

  updateFields(id, fields, type = 'updated') {
    const workflow = this.data.workflows.find((item) => item.id === id);
    if (!workflow) throw new Error('workflow not found');
    if (fields && (Object.prototype.hasOwnProperty.call(fields, 'acceptedTurnSnapshot')
      || Object.prototype.hasOwnProperty.call(fields, 'acceptedTurn'))) {
      throw new TypeError('accepted turn snapshot is immutable');
    }
    if (fields && Object.prototype.hasOwnProperty.call(fields, 'settingsSnapshot')) {
      throw new TypeError('settings snapshot is immutable');
    }
    if (fields && Object.prototype.hasOwnProperty.call(fields, 'permissionSnapshot')) {
      throw new TypeError('permission snapshot is immutable');
    }
    Object.assign(workflow, fields || {});
    return this.update(workflow, type);
  }

  acceptTurn(id, snapshot) {
    const workflow = this.data.workflows.find((item) => item.id === id);
    if (!workflow) throw new Error('workflow not found');
    const accepted = normalizeAcceptedTurnSnapshot(snapshot);
    if (!accepted) throw new TypeError('accepted turn snapshot is invalid or unverified');
    if (workflow.acceptedTurnSnapshot && workflow.acceptedTurnSnapshot.turnId === accepted.turnId
      && JSON.stringify(workflow.acceptedTurnSnapshot) !== JSON.stringify(accepted)) {
      throw new TypeError('accepted turn snapshot is immutable');
    }
    workflow.acceptedTurnSnapshot = accepted;
    workflow.acceptedTurn = accepted;
    workflow.profileApplyReconciled = false;
    return this.update(workflow, 'turn_accepted');
  }

  clearAcceptedTurn(id) {
    const workflow = this.data.workflows.find((item) => item.id === id);
    if (!workflow) throw new Error('workflow not found');
    workflow.acceptedTurnSnapshot = null;
    workflow.acceptedTurn = null;
    workflow.profileApplyReconciled = false;
    return this.update(workflow, 'turn_snapshot_cleared');
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

  recordRouting(id, { summary = null, auditEvent = null, auditEvents = null } = {}) {
    const workflow = this.data.workflows.find((item) => item.id === id);
    if (!workflow) throw new Error('workflow not found');
    const safeSummary = normalizeRoutingSummary(summary);
    const routingAudit = Array.isArray(workflow.routingAudit) ? [...workflow.routingAudit] : [];
    const incomingEvents = Array.isArray(auditEvents) ? auditEvents : (auditEvent ? [auditEvent] : []);
    for (const event of incomingEvents) {
      const safeEvent = normalizeRoutingAuditEvent(event);
      if (safeEvent) routingAudit.push(safeEvent);
    }
    const fields = { routingAudit: routingAudit.slice(-100) };
    if (summary !== null) fields.lastRouting = safeSummary;
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
      kind: String(entry.kind || (String(entry.phase || '').includes('APPLY') ? 'profile_apply' : 'dispatch')).slice(0, 30),
      attempt: Number.isInteger(entry.attempt) && entry.attempt >= 0 ? entry.attempt : 0,
      state, phase: String(entry.phase || '').slice(0, 60), sendAttempted: entry.sendAttempted === true,
      instructionFingerprint: String(entry.instructionFingerprint || '').slice(0, 128),
      routeRequest: safeRouteRequest(entry.routeRequest),
      resolvedProfile: safeResolvedProfile(entry.resolvedProfile || entry.profile),
      deliverySnapshot: safeDeliverySnapshot(entry.deliverySnapshot || entry.delivery_snapshot),
      reasonCode: safeCode(entry.reasonCode || entry.failureReasonCode, 80),
      at: Date.now(),
    };
    this.data.wal.push(record);
    this.emitEvent('wal_' + state, workflowId);
    this.save();
    return { ...record };
  }

  listWal(workflowId) {
    return this.data.wal.filter((entry) => !workflowId || entry.workflowId === workflowId).map((entry) => deepClone(entry));
  }

  listPendingWal(workflowId) {
    const latest = new Map();
    for (const entry of this.data.wal) {
      if (workflowId && entry.workflowId !== workflowId) continue;
      latest.set(`${entry.workflowId}:${entry.operationId}`, entry);
    }
    return [...latest.values()].filter((entry) => entry.state === 'pending').map((entry) => deepClone(entry));
  }

  appendDispatchRecord(workflowId, record = {}) {
    if (!this.data.workflows.some((workflow) => workflow.id === workflowId)) throw new Error('workflow not found');
    const acceptedTurn = normalizeAcceptedTurnSnapshot(record.acceptedTurn || record.acceptedTurnSnapshot);
    const safe = {
      id: 'dispatch-' + crypto.randomUUID(), workflowId, attempt: Number(record.attempt || 0), state: String(record.state || ''),
      instructionFingerprint: String(record.instructionFingerprint || '').slice(0, 128), turnContract: safeTurnContract(record.turnContract),
      routeRequest: safeRouteRequest(record.routeRequest || (acceptedTurn && acceptedTurn.routeRequest)),
      resolvedModel: safeText(record.resolvedModel || (acceptedTurn && acceptedTurn.resolvedProfile.modelId), 200),
      resolvedReasoning: safeText(record.resolvedReasoning || (acceptedTurn && acceptedTurn.resolvedProfile.reasoningLevel), 30).toLowerCase(),
      profileApplyMethod: safeText(record.profileApplyMethod, 40),
      profileVerification: safeVerification(record.profileVerification || (acceptedTurn && acceptedTurn.verification)),
      acceptedTurn: acceptedTurn ? deepClone(acceptedTurn) : null,
      phase: String(record.phase || '').slice(0, 60), failureReasonCode: safeCode(record.failureReasonCode, 80),
      routing: normalizeRoutingSummary(record.routing),
      sessionRef: safeText(record.sessionRef, 200),
      sessionSeqBefore: safeSequence(record.sessionSeqBefore ?? record.session_seq_before),
      identityProof: safeProof(record.identityProof || record.identity_proof, 'identity'),
      deliveryProof: safeProof(record.deliveryProof || record.delivery_proof, 'delivery'),
      startedAt: safeTimestamp(record.startedAt ?? record.started_at),
      completedAt: safeTimestamp(record.completedAt ?? record.completed_at) || Date.now(),
      at: Date.now(),
    };
    this.data.dispatchRecords.push(safe);
    this.emitEvent('dispatch_recorded', workflowId);
    this.save();
    return { ...safe };
  }

  listDispatchRecords(workflowId) {
    return this.data.dispatchRecords.filter((record) => !workflowId || record.workflowId === workflowId).map((record) => deepClone(record));
  }

  emitEvent(type, workflowId) {
    this.data.events.push({ id: crypto.randomUUID(), type, workflowId, at: Date.now() });
  }
}

module.exports = { TRANSITIONS, WorkflowStore };
