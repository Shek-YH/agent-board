'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { HANDOFF_STEP_STATUSES, normalizeHandoffChain, normalizeRunContract } = require('./run-contract');
const { autoStateForStatus, statusForAutoState, assertAutoTransition, AUTO_STATES } = require('./fsm');
const { normalizeEvidence } = require('./progress');
const { normalizeRoutingAuditEvent } = require('./routing/audit');
const { normalizeSettingsSnapshot } = require('./settings-store');
const { normalizeTaskContract } = require('./task-intake');
const { buildPermissionSnapshot, normalizePermissionSnapshot } = require('./permission-snapshot');
const { normalizeResearchState } = require('./researcher');
const { normalizeHostedControl } = require('./hosted-agent');

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
  if (workflow.handoffChain) copy.handoffChain = deepClone(workflow.handoffChain);
  if (workflow.researchState) copy.researchState = deepClone(workflow.researchState);
  if (workflow.hostedControl) copy.hostedControl = deepClone(workflow.hostedControl);
  return copy;
}

function normalizeWorkflowHandoffChain(value) {
  if (!Array.isArray(value)) return [];
  return normalizeHandoffChain(value).map((step) => ({ ...step }));
}

function currentHandoffStep(workflow) {
  const chain = workflow && Array.isArray(workflow.handoffChain) ? workflow.handoffChain : [];
  if (!chain.length) return null;
  const done = new Set(chain.filter((step) => step.status === 'done').map((step) => step.id));
  const step = chain.find((item) => item.status !== 'done') || null;
  if (!step) return { step: null, blocked: false, complete: true, missingDependencies: [] };
  const missingDependencies = step.dependsOn.filter((dependency) => !done.has(dependency));
  return { step, blocked: missingDependencies.length > 0, complete: false, missingDependencies };
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
  let handoffChainInvalid = false;
  if (!normalized.autopilotMode) normalized.autopilotMode = 'suggest';
  try {
    normalized.runContract = normalized.runContract
      ? normalizeRunContract(normalized.runContract)
      : legacyRunContract(normalized);
  } catch {
    normalized.runContract = legacyRunContract(normalized);
    handoffChainInvalid = Array.isArray(workflow && workflow.handoffChain)
      || Boolean(workflow && workflow.runContract && Array.isArray(workflow.runContract.handoffChain));
  }
  normalized.autopilotMode = normalized.runContract.autopilotMode;
  normalized.hostedControl = normalizeHostedControl(
    Object.prototype.hasOwnProperty.call(normalized, 'hostedControl')
      ? normalized.hostedControl
      : { enabled: normalized.autopilotMode === 'auto' },
  );
  if (normalized.autopilotMode === 'auto' && !Object.prototype.hasOwnProperty.call(workflow || {}, 'hostedControl')) {
    normalized.hostedControl.enabled = true;
  }
  normalized.autoState = AUTO_STATES.includes(normalized.autoState)
    ? normalized.autoState : autoStateForStatus(normalized.status);
  if (!Array.isArray(normalized.observedEvidence)) normalized.observedEvidence = [];
  if (!Object.prototype.hasOwnProperty.call(normalized, 'lastSuggestion')) normalized.lastSuggestion = null;
  if (!Object.prototype.hasOwnProperty.call(normalized, 'progress')) normalized.progress = null;
  if (!Object.prototype.hasOwnProperty.call(normalized, 'lastReceipt')) normalized.lastReceipt = null;
  if (!Object.prototype.hasOwnProperty.call(normalized, 'binding')) normalized.binding = null;
  if (Array.isArray(normalized.handoffChain)) {
    try { normalized.handoffChain = normalizeWorkflowHandoffChain(normalized.handoffChain); } catch { normalized.handoffChain = []; handoffChainInvalid = true; }
  } else if (normalized.runContract && Array.isArray(normalized.runContract.handoffChain)) {
    try { normalized.handoffChain = normalizeWorkflowHandoffChain(normalized.runContract.handoffChain); } catch { normalized.handoffChain = []; handoffChainInvalid = true; }
  } else {
    normalized.handoffChain = [];
  }
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
  normalized.researchState = normalizeResearchState(normalized.researchState || (normalized.taskContract && normalized.taskContract.research));
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
  if (!Number.isInteger(normalized.budgetUsed) || normalized.budgetUsed < 0) normalized.budgetUsed = 0;
  if (!Number.isInteger(normalized.routingEscalations)) normalized.routingEscalations = 0;
  if (!Number.isInteger(normalized.routingDowngrades)) normalized.routingDowngrades = 0;
  if (!Number.isInteger(normalized.lastReconciledRunCount) || normalized.lastReconciledRunCount < 0) normalized.lastReconciledRunCount = 0;
  if (!Object.prototype.hasOwnProperty.call(normalized, 'lastReconciledAt')) normalized.lastReconciledAt = null;
  if (!Object.prototype.hasOwnProperty.call(normalized, 'lastReconciliation')) normalized.lastReconciliation = null;
  if (!Object.prototype.hasOwnProperty.call(normalized, 'stopReason')) normalized.stopReason = null;
  if (!Object.prototype.hasOwnProperty.call(normalized, 'startedAt')) normalized.startedAt = null;
  if (!Object.prototype.hasOwnProperty.call(normalized, 'endedAt')) normalized.endedAt = null;
  if (handoffChainInvalid) {
    normalized.autoState = 'PAUSED';
    normalized.status = 'paused';
    normalized.lastError = 'HANDOFF_CHAIN_INVALID';
    normalized.stopReason = 'Need Human';
  }
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
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
    const tempPath = this.filePath + '.tmp';
    let json;
    try { json = JSON.stringify(this.data); } catch (error) { return; }
    try {
      fs.writeFileSync(tempPath, json, 'utf8');
      fs.renameSync(tempPath, this.filePath);
    } catch (error) {
      // rename 抛 ENOENT/EPERM（杀软抢 tmp / 目标被锁）：不能让它崩掉整个进程。
      // 退化为直接写主文件；仍失败则只记录，不影响 AutoPilot 内存态继续运行。
      try {
        fs.writeFileSync(this.filePath, json, 'utf8');
      } catch (fallbackError) {
        try {
          fs.appendFileSync(
            path.join(dir, 'workflow-save-error.log'),
            `${new Date().toISOString()} [inplace] ${fallbackError.code || ''} ${fallbackError.message}\n`
          );
        } catch { /* ignore */ }
      }
    }
  }

  emit(type, workflow) {
    this.data.events.push({ id: crypto.randomUUID(), type, workflowId: workflow.id, at: Date.now() });
    // events 是审计日志，会随每次状态变更无限增长（workflows.json 已到 68MB）；
    // 只保留最近 2000 条，防止单文件持续膨胀拖慢每次同步 save。
    if (this.data.events.length > 5000) {
      this.data.events = this.data.events.slice(-2000);
    }
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
    handoffChain = undefined,
    hostedControl = undefined,
  }) {
    const contract = runContract || normalizeRunContract({
      autopilotMode,
      goal: executionPlan && executionPlan.goal ? executionPlan.goal : '完成用户目标',
      verify: { dod: ['完成用户目标'] },
    });
    let normalizedHandoffChain = [];
    const requestedHandoffChain = handoffChain === undefined ? contract.handoffChain : handoffChain;
    if (requestedHandoffChain !== undefined) normalizedHandoffChain = normalizeWorkflowHandoffChain(requestedHandoffChain);
    const requestedHostedControl = hostedControl === undefined
      ? { enabled: contract.autopilotMode === 'auto' }
      : { ...hostedControl, enabled: hostedControl.enabled === true };
    const workflow = {
      id: 'wf-' + crypto.randomUUID(), projectPath: String(projectPath), mode, agent: String(agent),
      requestedBy: String(requestedBy), classification, executionPlan,
      autopilotMode: contract.autopilotMode, runContract: normalizeRunContract(contract),
      settingsSnapshot: settingsSnapshot ? normalizeSettingsSnapshot(settingsSnapshot) : null,
      permissionSnapshot: permissionSnapshot ? normalizePermissionSnapshot(permissionSnapshot) : buildPermissionSnapshot({ projectPath }),
      taskContract: taskContract ? normalizeTaskContract(taskContract) : null,
      researchState: normalizeResearchState(taskContract && taskContract.research),
      handoffChain: normalizedHandoffChain,
      hostedControl: normalizeHostedControl(requestedHostedControl),
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
      budgetUsed: 0,
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
      const incomingRaw = workflow.permissionSnapshot;
      const storedRaw = stored.permissionSnapshot;
      if (JSON.stringify(incomingRaw) !== JSON.stringify(storedRaw)) {
        const incoming = incomingRaw ? normalizePermissionSnapshot(incomingRaw) : null;
        if (JSON.stringify(incoming) !== JSON.stringify(storedRaw)) {
          throw new TypeError('permission snapshot is immutable');
        }
      }
    }
    if (Object.prototype.hasOwnProperty.call(workflow, 'handoffChain')) {
      workflow.handoffChain = normalizeWorkflowHandoffChain(workflow.handoffChain);
    }
    if (Object.prototype.hasOwnProperty.call(workflow, 'researchState')) {
      workflow.researchState = normalizeResearchState(workflow.researchState);
    }
    if (Object.prototype.hasOwnProperty.call(workflow, 'hostedControl')) {
      workflow.hostedControl = normalizeHostedControl(workflow.hostedControl);
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
    if (fields && Object.prototype.hasOwnProperty.call(fields, 'handoffChain')) {
      fields = { ...fields, handoffChain: normalizeWorkflowHandoffChain(fields.handoffChain) };
    }
    if (fields && Object.prototype.hasOwnProperty.call(fields, 'researchState')) {
      fields = { ...fields, researchState: normalizeResearchState(fields.researchState) };
    }
    if (fields && Object.prototype.hasOwnProperty.call(fields, 'hostedControl')) {
      fields = { ...fields, hostedControl: normalizeHostedControl(fields.hostedControl) };
    }
    Object.assign(workflow, fields || {});
    return this.update(workflow, type);
  }

  updateHandoffStep(id, stepId, patch = {}) {
    const workflow = this.data.workflows.find((item) => item.id === id);
    if (!workflow) throw new Error('workflow not found');
    if (!Array.isArray(workflow.handoffChain) || !workflow.handoffChain.length) throw new Error('handoffChain is not configured');
    const index = workflow.handoffChain.findIndex((step) => step.id === String(stepId || '').trim());
    if (index < 0) throw new Error('handoff step not found');
    const current = workflow.handoffChain[index];
    const next = { ...current };
    const allowed = ['status', 'sessionRef', 'attempts', 'startedAt', 'completedAt', 'result', 'evidenceSnapshot', 'researchState'];
    for (const field of allowed) {
      if (!Object.prototype.hasOwnProperty.call(patch, field)) continue;
      if (field === 'status') {
        if (!HANDOFF_STEP_STATUSES.includes(String(patch.status))) throw new TypeError('invalid handoff step status');
        if (current.status === 'done' && String(patch.status) !== 'done') throw new TypeError('completed handoff step is immutable');
        if (String(patch.status) === 'done'
          && (!patch.evidenceSnapshot || patch.evidenceSnapshot.verified !== true || patch.evidenceSnapshot.completed !== true)) {
          throw new TypeError('handoff step DONE requires verified evidence');
        }
        if (String(patch.status) === 'done' && current.dependsOn.some((dependency) => {
          const prerequisite = workflow.handoffChain.find((step) => step.id === dependency);
          return !prerequisite || prerequisite.status !== 'done';
        })) throw new TypeError('handoff step dependencies are unfinished');
        next.status = String(patch.status);
      } else if (field === 'attempts') {
        if (!Number.isInteger(patch.attempts) || patch.attempts < 0 || patch.attempts > 100) throw new TypeError('invalid handoff step attempts');
        next.attempts = patch.attempts;
      } else if (field === 'startedAt' || field === 'completedAt') {
        if (patch[field] !== null && (!Number.isFinite(patch[field]) || patch[field] < 0)) throw new TypeError(`invalid handoff step ${field}`);
        next[field] = patch[field];
      } else if (field === 'sessionRef') {
        const rawValue = String(patch[field] || '').trim();
        if (/[\r\n\t]/.test(rawValue)) throw new TypeError('invalid handoff step sessionRef');
        next[field] = rawValue.slice(0, 300);
      } else if (field === 'result') {
        next[field] = normalizeHandoffChain([{
          ...current, result: patch[field], evidenceSnapshot: current.evidenceSnapshot,
        }])[0].result;
      } else if (field === 'evidenceSnapshot') {
        next[field] = normalizeHandoffChain([{
          ...current, result: current.result, evidenceSnapshot: patch[field],
        }])[0].evidenceSnapshot;
      } else if (field === 'researchState') {
        next[field] = normalizeResearchState({ ...(current.researchState || {}), ...(patch[field] || {}) });
      }
    }
    workflow.handoffChain[index] = next;
    if (next.status === 'done') {
      const done = new Set(workflow.handoffChain.filter((step) => step.status === 'done').map((step) => step.id));
      workflow.handoffChain = workflow.handoffChain.map((step) => (
        step.status === 'pending' && step.dependsOn.every((dependency) => done.has(dependency))
          ? { ...step, status: 'ready' } : step
      ));
    }
    return this.update(workflow, 'handoff_step_updated');
  }

  updateResearchState(id, patch = {}) {
    const workflow = this.data.workflows.find((item) => item.id === id);
    if (!workflow) throw new Error('workflow not found');
    workflow.researchState = normalizeResearchState({ ...workflow.researchState, ...(patch || {}) });
    return this.update(workflow, 'research_state_updated');
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

module.exports = { TRANSITIONS, WorkflowStore, currentHandoffStep };
