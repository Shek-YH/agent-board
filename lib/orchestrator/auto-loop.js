'use strict';

const crypto = require('node:crypto');
const { dispatchVerifiedMessage } = require('../verified-dispatch');
const { enrichVerifiedTarget } = require('../verified-dispatch-target');
const { calculateProgress } = require('./progress');
const { applySupervisorReview, buildSupervisorDecision, sanitizeSupervisorDecision } = require('./supervisor');
const { evaluatePolicyGate } = require('./policy-gate');
const { checkWatchdog } = require('./watchdog');
const { GuiBus } = require('./gui-bus');
const { buildRunReceipt } = require('./run-receipt');
const { reconcilePendingDispatch } = require('./reconciliation');
const { buildRoutingAuditEvent } = require('./routing/audit');
const { isInsideRoot } = require('./project-lifecycle');
const { hasHumanInterventionBeforeDispatch } = require('./completion-detector');
const { currentHandoffStep } = require('./workflow-store');
const { normalizeResearchState } = require('./researcher');
const { mergeResearchIntoTaskContract } = require('./task-intake');
const { normalizeRunContract } = require('./run-contract');
const { classifyHostedAgentReply, normalizeHostedControl, fingerprint } = require('./hosted-agent');
const { runPreflightSession } = require('./phases/preflight');

const DEFAULT_MAX_STEP_RUNTIME = 15 * 60 * 1000;
const DEFAULT_MAX_RETRIES = 3;
const SAFE_MONITORING_ERRORS = new Set([
  'HOSTED_RECONCILE_FAILED', 'TARGET_NOT_UNIQUE', 'AUTOPILOT_STARTUP_FAILED', 'AUTOPILOT_TIMER_FAILED',
]);

function errorFingerprint(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex').slice(0, 64);
}

function gateState(reasonCode) {
  return ['NEED_HUMAN', 'PERMISSION_REQUIRED', 'IDENTITY_UNVERIFIED', 'DELIVERY_UNVERIFIED', 'PROFILE_UNVERIFIED'].includes(reasonCode)
    ? 'PAUSED' : 'BLOCKED';
}

function stopReason(reasonCode, reason) {
  if (String(reasonCode || '').startsWith('NEED_HUMAN') || reasonCode === 'PERMISSION_REQUIRED') return 'Need Human';
  if (reasonCode === 'HUMAN_INTERVENTION') return 'Human Intervention';
  if (reasonCode === 'IDENTITY_UNVERIFIED') return 'Identity Unverified';
  if (reasonCode === 'DUPLICATE_INSTRUCTION') return 'Stagnation';
  if (reasonCode === 'DELIVERY_UNVERIFIED') return 'Delivery Unverified';
  if (reasonCode === 'PROFILE_UNVERIFIED' || reasonCode === 'PROFILE_VERIFY_FAILED' || reasonCode === 'SESSION_DRIFT') return 'Profile Apply Unverified';
  if (reason === 'Budget Exceeded') return 'Budget Exceeded';
  if (reason === 'Stagnation') return 'Stagnation';
  return 'Blocked';
}

function dispatchEvidence(result, phase) {
  const evidence = result && result.evidence;
  const value = evidence && evidence[phase];
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function dispatchIdentityProof(result) {
  const verification = dispatchEvidence(result, 'RE_VERIFY_SESSION') || dispatchEvidence(result, 'VERIFY_SESSION');
  return verification && verification.verification ? verification.verification : verification;
}

function dispatchDeliveryProof(result) {
  return dispatchEvidence(result, 'VERIFY_DELIVERY');
}

function dispatchSessionSeqBefore(result) {
  const reVerification = dispatchEvidence(result, 'RE_VERIFY_SESSION');
  const snapshot = result && result.evidence && (result.evidence.DELIVERY_SNAPSHOT || reVerification?.deliverySnapshot);
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
  const sequence = snapshot.sessionSeqBefore ?? snapshot.session_seq_before ?? snapshot.seqBefore ?? snapshot.sequence ?? snapshot.seq;
  return Number.isInteger(sequence) && sequence >= 0 ? sequence : null;
}

function deliverySnapshotFromResult(result) {
  const evidence = result && result.evidence;
  const reVerification = dispatchEvidence(result, 'RE_VERIFY_SESSION');
  return evidence && (evidence.DELIVERY_SNAPSHOT || reVerification?.deliverySnapshot) || null;
}

function sequenceFromDeliverySnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
  const sequence = snapshot.sessionSeqBefore ?? snapshot.session_seq_before ?? snapshot.seqBefore ?? snapshot.sequence ?? snapshot.seq;
  return Number.isInteger(sequence) && sequence >= 0 ? sequence : null;
}

function isNativeTurn(workflow, dependencies) {
  return String(workflow && workflow.agent || '').trim().toLowerCase() === 'codex'
    && workflow && workflow.binding && workflow.binding.transport === 'codex-app-server'
    && dependencies && typeof dependencies.nativeDispatch === 'function';
}

function nativeSessionTarget(workflow) {
  const binding = workflow && workflow.binding || {};
  return {
    sessionRef: binding.sessionRef,
    agent: workflow.agent,
    project: binding.projectPath,
    role: 'main',
    controlEligibility: 'eligible',
    strongAnchor: true,
    messages: [],
  };
}

function dispatchMessageId(result) {
  const candidates = [
    result && result.messageId,
    result && result.sentMessageId,
    result && result.deliveryProof && result.deliveryProof.messageId,
    result && result.evidence && result.evidence.VERIFY_DELIVERY && result.evidence.VERIFY_DELIVERY.messageId,
  ];
  const value = candidates.find((item) => (typeof item === 'string' && item.trim()) || Number.isInteger(item));
  return value === undefined ? '' : String(value).trim();
}

function normalizeActivityPath(value) {
  return String(value || '').trim().replace(/[\\/]+$/, '').toLowerCase();
}

function activityMessageId(activity) {
  if (!activity || typeof activity !== 'object') return '';
  const explicit = String(activity.messageId || activity.messageFingerprint || '').trim();
  if (explicit) return explicit;
  const sourceId = String(activity.sourceId || '').trim();
  return sourceId ? fingerprint(sourceId) : '';
}

function sameActivitySession(binding, activity) {
  const expected = String(binding && binding.sessionRef || '').trim();
  const actual = String(activity && activity.sessionRef || '').trim();
  if (!expected || !actual) return false;
  if (expected === actual) return true;
  const agent = String(activity && activity.agent || '').trim();
  return agent && actual === `${agent}:${expected}`;
}

class AutoLoop {
  constructor({
    store, allowedRoots = [], resolveDependencies, resolveCompletionDetector, dispatch = dispatchVerifiedMessage,
    routingRuntime = null,
    profileReader = null,
    guiBus = new GuiBus(), now = () => Date.now(), owner = 'autopilot', leaseMs = 60_000,
    reconcileEveryTurns = 3,
    onWorkflowChange,
    supervisorReview = null,
    evidenceCollector = null,
    sessionProvisioners = {}, researcher = null,
  } = {}) {
    if (!store || typeof store.get !== 'function') throw new TypeError('workflow store is required');
    this.store = store;
    this.allowedRoots = allowedRoots;
    this.resolveDependencies = resolveDependencies;
    this.resolveCompletionDetector = resolveCompletionDetector;
    this.dispatch = dispatch;
    this.routingRuntime = routingRuntime;
    this.profileReader = profileReader;
    this.guiBus = guiBus;
    this.now = now;
    this.owner = owner;
    this.leaseMs = leaseMs;
    const interval = Number(reconcileEveryTurns);
    this.reconcileEveryTurns = Number.isInteger(interval) && interval >= 1 && interval <= 5 ? interval : 3;
    this.onWorkflowChange = onWorkflowChange;
    this.supervisorReview = supervisorReview;
    this.evidenceCollector = evidenceCollector;
    this.sessionProvisioners = sessionProvisioners || {};
    this.researcher = researcher && typeof researcher.research === 'function' ? researcher : null;
    this.locks = new Map();
    this.pendingActivity = new Map();
    this.timer = null;
  }

  notify(workflow) {
    if (typeof this.onWorkflowChange === 'function') this.onWorkflowChange(workflow);
    return workflow;
  }

  enqueue(id, task) {
    const key = String(id || '');
    const previous = this.locks.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(task);
    this.locks.set(key, current);
    const cleanup = () => { if (this.locks.get(key) === current) this.locks.delete(key); };
    current.then(cleanup, cleanup);
    return current;
  }

  run(workflowId) {
    const id = String(workflowId || '');
    return this.enqueue(id, () => this.runOnce(id));
  }

  onSessionActivity(activity) {
    const role = String(activity && activity.role || '').toLowerCase();
    if (!['assistant', 'agent', 'model'].includes(role)) {
      return Promise.resolve({ scheduled: false, reasonCode: 'ROLE_IGNORED' });
    }
    const agent = String(activity && activity.agent || '').trim().toLowerCase();
    const project = normalizeActivityPath(activity && (activity.project || activity.projectPath));
    const workflows = this.store.list().filter((workflow) => {
      if (workflow.autopilotMode !== 'auto' || workflow.hostedControl?.enabled !== true) return false;
      const binding = workflow.binding || {};
      const expectedAgent = String(binding.agent || workflow.agent || '').trim().toLowerCase();
      if (!agent || expectedAgent !== agent || !sameActivitySession(binding, activity)) return false;
      const expectedProject = normalizeActivityPath(binding.projectPath);
      return Boolean(project && expectedProject && project === expectedProject);
    });
    if (!workflows.length) return Promise.resolve({ scheduled: false, reasonCode: 'TARGET_NOT_FOUND' });
    if (workflows.length > 1) {
      return Promise.all(workflows.map((workflow) => this.recordMonitoringFailure(workflow.id, 'TARGET_NOT_UNIQUE')))
        .then(() => ({ scheduled: false, reasonCode: 'TARGET_NOT_UNIQUE' }));
    }
    const workflow = workflows[0];
    const control = normalizeHostedControl(workflow.hostedControl);
    const messageId = activityMessageId(activity);
    if (messageId && control.lastAgentMessageId === messageId) {
      return Promise.resolve({ scheduled: false, reasonCode: 'REPLY_ALREADY_OBSERVED' });
    }
    if (this.pendingActivity.has(workflow.id)) return this.pendingActivity.get(workflow.id);
    const pending = this.reconcile(workflow.id)
      .then((result) => ({ scheduled: true, workflow: result }))
      .catch(() => this.recordMonitoringFailure(workflow.id, 'HOSTED_RECONCILE_FAILED')
        .then((result) => ({ scheduled: true, workflow: result, errorCode: 'HOSTED_RECONCILE_FAILED' })))
      .finally(() => {
        if (this.pendingActivity.get(workflow.id) === pending) this.pendingActivity.delete(workflow.id);
      });
    this.pendingActivity.set(workflow.id, pending);
    return pending;
  }

  recordMonitoringFailure(workflowId, reasonCode = 'HOSTED_RECONCILE_FAILED') {
    const workflow = this.store.get(workflowId);
    if (!workflow || ['DONE', 'STOPPED'].includes(workflow.autoState)) return Promise.resolve(workflow);
    const code = SAFE_MONITORING_ERRORS.has(reasonCode) ? reasonCode : 'HOSTED_RECONCILE_FAILED';
    let current = this.store.updateFields(workflow.id, {
      lastError: code, stopReason: 'Need Human', endedAt: this.now(),
    }, 'monitoring_failed');
    if (current.autoState !== 'PAUSED') {
      try { current = this.store.transitionState(current.id, 'PAUSED', 'monitoring_failed'); } catch { /* keep the safe error */ }
    }
    return Promise.resolve(this.notify(this.store.get(current.id) || current));
  }

  recordMonitoringFailureForActive(reasonCode) {
    const workflows = this.store.list().filter((workflow) => workflow.autopilotMode === 'auto');
    return Promise.all(workflows.map((workflow) => this.recordMonitoringFailure(workflow.id, reasonCode)));
  }

  async runOnce(id) {
    let workflow = this.store.get(id);
    if (!workflow) return null;
    if (workflow.autopilotMode !== 'auto') return workflow;
    if (workflow.autoState === 'DONE' || workflow.autoState === 'STOPPED') return workflow;
    if (workflow.autoState === 'PAUSED' || workflow.autoState === 'BLOCKED') return workflow;
    if (workflow.controlOwner === 'human') return workflow;

    const handoffEnabled = Array.isArray(workflow.handoffChain) && workflow.handoffChain.length > 0;
    const refreshExecutionView = (candidate) => handoffEnabled
      ? this.handoffView(candidate, currentHandoffStep(candidate)) : candidate;
    let handoffState = handoffEnabled ? currentHandoffStep(workflow) : null;
    if (!handoffEnabled && workflow.taskContract && ['required', 'unresolved', 'researching'].includes(workflow.researchState?.status)) {
      const preparedResearch = await this.prepareWorkflowResearch(workflow);
      if (preparedResearch.error) {
        const terminal = ['RESEARCH_TIMEOUT', 'RESEARCH_BUDGET_EXCEEDED', 'RESEARCH_SOURCE_LIMIT'].includes(preparedResearch.error.code);
        return this.finish(preparedResearch.workflow, terminal ? 'STOPPED' : 'PAUSED', terminal ? 'Budget Exceeded' : 'Need Human', null, preparedResearch.error.code);
      }
      workflow = preparedResearch.workflow;
    }
    if (handoffEnabled) {
      const prepared = await this.prepareHandoffStep(workflow);
      if (prepared.error) return this.pauseHandoff(prepared.workflow, prepared.state, prepared.error, prepared.terminal === true);
      workflow = prepared.workflow;
      handoffState = currentHandoffStep(workflow);
      if (handoffState && !handoffState.complete) {
        workflow = this.activateHandoffStep(workflow, handoffState);
        handoffState = currentHandoffStep(workflow);
      }
      workflow = refreshExecutionView(workflow);
    }

    if (workflow.autoState === 'OFF') workflow = refreshExecutionView(this.store.transitionState(id, 'PREFLIGHT', 'auto_preflight'));
    if (workflow.autoState === 'PREFLIGHT') workflow = refreshExecutionView(this.store.transitionState(id, 'WAITING_AGENT', 'waiting_agent'));
    if (workflow.autoState === 'WAITING_AGENT') workflow = refreshExecutionView(this.store.transitionState(id, 'REVIEWING', 'auto_review'));
    if (workflow.controlOwner !== this.owner) workflow = refreshExecutionView(this.store.claim(id, this.owner, this.leaseMs, this.now()));
    if (handoffEnabled && currentHandoffStep(workflow)?.complete) {
      return this.finish(this.store.get(id) || workflow, 'DONE', 'DoD Complete', workflow.lastDecision || null);
    }

    const dependencies = typeof this.resolveDependencies === 'function' ? this.resolveDependencies(workflow.agent, workflow) : null;
    const nativeTurn = isNativeTurn(workflow, dependencies);
    const session = nativeTurn ? nativeSessionTarget(workflow) : await this.preflightSession(workflow, dependencies);
    const sessionSnapshot = nativeTurn && Number(workflow.runCount || 0) === 0
      ? { messages: [] }
      : await this.readSessionSnapshot(workflow, dependencies, nativeTurn ? null : session);
    if (Number(workflow.runCount || 0) === 0 && hasHumanInterventionBeforeDispatch(sessionSnapshot, workflow)) {
      if (handoffEnabled) return this.pauseHandoff(this.store.get(id) || workflow, currentHandoffStep(workflow), {
        code: 'HANDOFF_NEED_HUMAN', reason: '发送前检测到人工介入',
      });
      workflow = refreshExecutionView(this.store.updateFields(id, {
        lastError: 'HUMAN_INTERVENTION', stopReason: 'Human Intervention',
      }, 'human_intervention_detected'));
      return this.finish(workflow, 'PAUSED', 'Human Intervention', null, 'HUMAN_INTERVENTION');
    }
    const hostedObservation = this.observeHostedReply(workflow, sessionSnapshot);
    workflow = refreshExecutionView(hostedObservation.workflow);
    const hostedReply = hostedObservation.reply;
    if (hostedObservation.fresh && hostedReply.status === 'blocked' && hostedReply.realSafetyBoundary === true) {
      // 真实安全边界（回复文本命中边界词）→ 必须暂停，交由人工确认。
      return this.finish(workflow, 'PAUSED', 'Need Human', null, hostedReply.reasonCode);
    }
    // Agent 自报 BLOCKED 但未命中任何安全边界词（如仅因换行符 \r\n 等琐碎差异误报）时，
    // 不在此硬停，交由下方 Supervisor 决策与多轮推进判断，避免「任务已完成却卡住」。
    if (hostedObservation.fresh && hostedReply.status === 'waiting_for_host') {
      return this.finish(workflow, 'PAUSED', 'Need Human', null, 'HOST_DECISION_REQUIRED');
    }
    const progress = calculateProgress({ workflow, now: this.now() });
    workflow = refreshExecutionView(this.store.updateFields(id, { progress }, 'progress_updated'));
    // A hosted Agent that explicitly reports STATUS: COMPLETED after a real turn must
    // reach DONE even when a stale budget/runtime guard (maxIterations / maxRuntime)
    // would otherwise mark progress blocked. Budget stops unfinished work, not a turn
    // the Agent declares finished. The optional LLM supervisor review can still
    // downgrade this DONE (e.g. to a verification round or NEED_HUMAN).
    const hostedCompleted = workflow.hostedControl?.enabled === true
      && hostedReply.status === 'completed'
      && Number(workflow.runCount || 0) > 0;
    const decisionProgress = hostedCompleted
      ? { ...progress, status: 'completed', completed: progress.total || 0, percent: 100, stopReason: null }
      : progress;
    let decision = buildSupervisorDecision({ workflow, progress: decisionProgress });
    const hostedAnswering = workflow.hostedControl?.enabled === true
      && hostedReply.status === 'question'
      && workflow.hostedControl.lastAgentMessageId !== workflow.hostedControl.lastHandledAgentMessageId
      && (Number(workflow.runCount || 0) > 0 || (hostedObservation.fresh && progress.status === 'completed'));
    if (hostedAnswering && decision.decision === 'DONE') {
      decision = buildSupervisorDecision({
        workflow,
        progress: { ...progress, status: 'in_progress', evidence: [] },
      });
      decision = {
        ...decision,
        reasonCode: 'HOSTED_AGENT_QUESTION',
        summary: '托管 Agent 提出普通问题，已由 Supervisor 自动决定继续执行。',
      };
    }
    let reviewResult = null;
    if (typeof this.supervisorReview === 'function') {
      try {
        reviewResult = await this.supervisorReview({ workflow, progress, session: sessionSnapshot || session, decision });
      } catch (_) {
        reviewResult = null;
      }
    }
    decision = applySupervisorReview({ workflow, progress, decision, reviewResult, hostedReply });
    if (hostedAnswering && decision.decision === 'CONTINUE') {
      decision = {
        ...decision,
        instruction: `${decision.instruction}\n本轮为托管 Agent 普通问题的自动决策回合：采用默认的最小可验证方案继续，不再等待用户确认。`,
      };
    }
    const safeDecision = sanitizeSupervisorDecision(decision);
    workflow = refreshExecutionView(this.store.updateFields(id, {
      lastDecision: safeDecision,
      lastTurnContract: safeDecision.turnContract,
    }, 'supervisor_decision'));

    if (decision.decision === 'DONE') {
      if (handoffEnabled) {
        const current = this.markHandoffStepDone(this.store.get(id) || workflow, currentHandoffStep(workflow), safeDecision, progress);
        return currentHandoffStep(current)?.complete
          ? this.finish(current, 'DONE', 'DoD Complete', safeDecision)
          : this.notify(current);
      }
      return this.finish(workflow, 'DONE', 'DoD Complete', safeDecision);
    }
    if (decision.decision === 'NEED_HUMAN') {
      if (handoffEnabled) return this.pauseHandoff(this.store.get(id) || workflow, currentHandoffStep(workflow), {
        code: decision.reasonCode || 'HANDOFF_NEED_HUMAN', reason: progress.stopReason || 'Supervisor 要求人工处理当前步骤',
      });
      return this.finish(workflow, 'PAUSED', progress.stopReason || 'Need Human', safeDecision);
    }

    const watchdog = checkWatchdog({ workflow, instruction: decision.instruction, now: this.now() });
    const capabilities = this.capabilities(dependencies);
    const gate = evaluatePolicyGate({ workflow, capabilities, session, instruction: decision.instruction, watchdog, allowedRoots: this.allowedRoots });
    if (!gate.allowed) {
      if (handoffEnabled) return this.pauseHandoff(this.store.get(id) || workflow, currentHandoffStep(workflow), {
        code: gate.reasonCode || 'HANDOFF_POLICY_BLOCKED', reason: gate.reason || '当前步骤未通过策略校验',
      });
      const state = gateState(gate.reasonCode);
      return this.finish(workflow, state, stopReason(gate.reasonCode, gate.reason), safeDecision, gate.reason);
    }

    const recoveredProfile = workflow.profileApplyReconciled === true && workflow.acceptedTurnSnapshot;
    if (recoveredProfile) {
      workflow = refreshExecutionView(this.store.updateFields(id, { profileApplyReconciled: false }, 'profile_reconciliation_resumed'));
    } else {
      if (workflow.acceptedTurnSnapshot && typeof this.store.clearAcceptedTurn === 'function') {
        workflow = refreshExecutionView(this.store.clearAcceptedTurn(id));
      }
      const routingOutcome = await this.prepareRouting({ workflow, progress, decision, safeDecision, dependencies });
      if (routingOutcome) {
        workflow = refreshExecutionView(this.recordRoutingOutcome(workflow, routingOutcome));
        const routeDecision = routingOutcome.decision || {};
        if (routeDecision.action === 'pause') {
          return this.finish(workflow, 'PAUSED', stopReason(routeDecision.reasonCode, 'Routing Paused'), safeDecision, routingOutcome.error || 'Routing paused');
        }
        if (routeDecision.action === 'apply' && (!routingOutcome.profileResult || routingOutcome.profileResult.ok !== true)) {
          const failure = routingOutcome.profileResult || {};
          workflow = refreshExecutionView(this.store.updateFields(workflow.id, {
            lastError: failure.error || failure.code || 'Profile Apply unverified',
            stopReason: 'Profile Apply Unverified',
          }, 'routing_failed'));
          return this.finish(workflow, 'PAUSED', 'Profile Apply Unverified', safeDecision, workflow.lastError);
        }
      }
    }

    workflow = refreshExecutionView(this.store.incrementRun(id));
    if (handoffEnabled) {
      const current = currentHandoffStep(workflow);
      if (!current || !current.step) return this.notify(workflow);
      workflow = this.store.updateHandoffStep(id, current.step.id, {
        status: 'running', attempts: current.step.attempts + 1,
        startedAt: current.step.startedAt === null ? this.now() : current.step.startedAt,
      });
      workflow = this.store.updateFields(id, { budgetUsed: Number(workflow.budgetUsed || 0) + 1 }, 'handoff_budget_used');
      workflow = refreshExecutionView(workflow);
    }
    workflow = refreshExecutionView(this.store.transitionState(id, 'DISPATCHING', 'auto_dispatching'));
    const operationId = 'op-' + crypto.randomUUID();
    const deliverySnapshot = nativeTurn ? null : await this.captureDeliveryBoundary(session, dependencies);
    if (!nativeTurn && dependencies && typeof dependencies.captureDeliverySnapshot === 'function' && !deliverySnapshot) {
      workflow = refreshExecutionView(this.store.updateFields(id, {
        lastError: '发送前送达边界快照不可用', stopReason: 'Delivery Unverified',
      }, 'delivery_snapshot_failed'));
      return this.finish(workflow, 'PAUSED', 'Delivery Unverified', safeDecision, workflow.lastError);
    }
    workflow = refreshExecutionView(this.store.get(id) || workflow);
    if (workflow.controlOwner === 'human' || ['PAUSED', 'BLOCKED', 'DONE', 'STOPPED'].includes(workflow.autoState)) {
      return this.notify(workflow);
    }
    this.store.appendWal(id, {
      operationId, kind: 'dispatch', attempt: workflow.runCount, state: 'pending', phase: 'DISPATCHING', sendAttempted: false,
      instructionFingerprint: watchdog.fingerprint, deliverySnapshot,
    });
    let result;
    const dispatchStartedAt = this.now();
    try {
      const dispatchRequest = (current) => ({
        agent: current.agent,
        project: current.binding.projectPath,
        sessionRef: current.binding.sessionRef,
        title: current.binding.title,
        message: decision.instruction,
      });
      const dispatchWithOwnershipCheck = async () => {
        const current = this.store.get(id);
        if (!current || current.controlOwner === 'human' || ['PAUSED', 'BLOCKED', 'DONE', 'STOPPED'].includes(current.autoState)) {
          return { ok: false, status: 'cancelled', phase: 'DISPATCH', cancelled: true, failure: { code: 'HUMAN_INTERVENTION', reason: '人工接管已生效，取消尚未发送的指令' } };
        }
        const request = dispatchRequest(current);
        return nativeTurn
          ? dependencies.nativeDispatch(request, { workflow: current, phase: 'DISPATCH' })
          : this.dispatch(request, dependencies);
      };
      result = nativeTurn
        ? await dispatchWithOwnershipCheck()
        : await this.guiBus.run({ agent: workflow.agent, sessionRef: workflow.binding.sessionRef }, dispatchWithOwnershipCheck);
    } catch (error) {
      result = { ok: false, status: 'failed', phase: 'DISPATCH', failure: { code: 'DISPATCH_FAILED', reason: error.message }, reconciliationRequired: false };
    }
    const dispatchCompletedAt = this.now();

    if (result && result.cancelled === true) {
      this.store.appendWal(id, {
        operationId, kind: 'dispatch', attempt: workflow.runCount, state: 'reconcile_required', phase: 'DISPATCH_ABORTED', sendAttempted: false,
        instructionFingerprint: watchdog.fingerprint, deliverySnapshot, reasonCode: 'HUMAN_INTERVENTION',
      });
      const current = this.store.get(id) || workflow;
      if (['PAUSED', 'BLOCKED', 'DONE', 'STOPPED'].includes(current.autoState)) return this.notify(current);
    }

    const sendAttempted = result && (result.reconciliationRequired === true
      || (Array.isArray(result.phases) && result.phases.some((phase) => phase.phase === 'SEND')));
    const walState = result && result.ok ? 'committed' : 'reconcile_required';
    this.store.appendWal(id, {
      operationId, kind: 'dispatch', attempt: workflow.runCount, state: walState, phase: result && result.phase || 'DISPATCH', sendAttempted,
      instructionFingerprint: watchdog.fingerprint,
      deliverySnapshot: deliverySnapshotFromResult(result) || deliverySnapshot,
      reasonCode: result && result.failure && result.failure.code || '',
    });
    const acceptedTurn = workflow.acceptedTurnSnapshot && workflow.acceptedTurnSnapshot.attempt === workflow.runCount
      ? workflow.acceptedTurnSnapshot : null;
    this.store.appendDispatchRecord(id, {
      attempt: workflow.runCount, state: result && result.ok ? 'committed' : 'failed',
      instructionFingerprint: watchdog.fingerprint, turnContract: safeDecision.turnContract,
      phase: result && result.phase || 'DISPATCH', failureReasonCode: result && result.failure && result.failure.code,
      routing: workflow.lastRouting,
      acceptedTurn,
      routeRequest: acceptedTurn && acceptedTurn.routeRequest,
      resolvedModel: acceptedTurn && acceptedTurn.resolvedProfile.modelId,
      resolvedReasoning: acceptedTurn && acceptedTurn.resolvedProfile.reasoningLevel,
      profileVerification: acceptedTurn && acceptedTurn.verification,
      sessionRef: workflow.binding.sessionRef,
      sessionSeqBefore: dispatchSessionSeqBefore(result) ?? sequenceFromDeliverySnapshot(deliverySnapshot),
      identityProof: dispatchIdentityProof(result),
      deliveryProof: dispatchDeliveryProof(result),
      startedAt: dispatchStartedAt,
      completedAt: dispatchCompletedAt,
    });
    if (!result || result.ok !== true || result.status !== 'committed') {
      const reason = sendAttempted ? 'Delivery Unverified' : 'Blocked';
      workflow = refreshExecutionView(this.store.updateFields(id, {
        lastError: result && result.failure && result.failure.reason || 'Verified Dispatch failed',
        lastInstructionFingerprint: watchdog.fingerprint,
        dispatchFailures: Number(workflow.dispatchFailures || 0) + 1,
        consecutiveFailures: Number(workflow.consecutiveFailures || 0) + 1,
        stopReason: reason,
      }, 'dispatch_failed'));
      if (handoffEnabled && currentHandoffStep(workflow)?.step && typeof this.store.updateHandoffStep === 'function') {
        workflow = refreshExecutionView(this.store.updateHandoffStep(id, currentHandoffStep(workflow).step.id, {
          status: 'paused', result: { code: result?.failure?.code || 'DISPATCH_FAILED', reason },
        }));
      }
      return this.finish(workflow, 'PAUSED', reason, safeDecision);
    }

    workflow = refreshExecutionView(this.store.updateFields(id, {
      lastError: '', lastInstructionFingerprint: watchdog.fingerprint,
      consecutiveFailures: 0, dispatchFailures: 0, stopReason: null,
      ...(workflow.hostedControl?.enabled === true ? {
        hostedControl: {
          ...normalizeHostedControl(workflow.hostedControl),
          round: Math.max(Number(workflow.hostedControl.round || 0), Number(workflow.runCount || 0)),
          lastSentMessageId: dispatchMessageId(result) || workflow.hostedControl.lastSentMessageId,
          lastDecisionAt: this.now(),
          ...(hostedAnswering ? { lastHandledAgentMessageId: hostedReply.messageId } : {}),
        },
      } : {}),
    }, 'dispatch_committed'));
    workflow = refreshExecutionView(this.store.transitionState(id, 'VERIFYING', 'delivery_verified'));
    workflow = refreshExecutionView(this.store.transitionState(id, 'WAITING_AGENT', 'waiting_agent'));
    if (handoffEnabled && currentHandoffStep(workflow)?.step && typeof this.store.updateHandoffStep === 'function') {
      workflow = refreshExecutionView(this.store.updateHandoffStep(id, currentHandoffStep(workflow).step.id, {
        status: 'waiting_agent',
      }));
    }
    workflow = await this.reconcileAfterTurn(workflow, dependencies, session, safeDecision);
    return this.notify(this.store.get(id) || workflow);
  }

  capabilities(dependencies) {
    const hasWriter = dependencies && dependencies.writer
      && typeof dependencies.writer.write === 'function' && typeof dependencies.writer.send === 'function';
    return {
      sessionIdentity: Boolean(dependencies && typeof dependencies.verifySession === 'function'),
      completionDetector: Boolean(dependencies && dependencies.completionDetector
        && typeof dependencies.completionDetector.detect === 'function'),
      messageWriter: Boolean(hasWriter),
      deliveryVerifier: Boolean(dependencies && typeof dependencies.verifyDelivery === 'function'),
      verifiedDispatch: typeof this.dispatch === 'function',
    };
  }

  async prepareRouting(context) {
    if (!this.routingRuntime || typeof this.routingRuntime.prepare !== 'function') return null;
    const workflow = context && context.workflow;
    const config = workflow && workflow.routingConfig || {};
    const trackApply = config.enabled === true && typeof this.store.appendWal === 'function';
    const operationId = trackApply ? 'profile-' + crypto.randomUUID() : null;
    const request = {
      enabled: config.enabled === true,
      action: 'apply', reasonCode: 'ROUTE_REQUESTED',
      routeRequest: {
        complexityTier: config.complexityTier,
        thinkingTier: config.thinkingTier,
        promptPolicy: config.promptPolicy,
      },
      resolvedProfile: null,
    };
    if (trackApply) {
      this.store.appendWal(workflow.id, {
        operationId, kind: 'profile_apply', attempt: Number(workflow.runCount || 0) + 1,
        state: 'pending', phase: 'MODEL_APPLY', sendAttempted: false, routeRequest: request.routeRequest,
      });
      if (typeof this.store.recordRouting === 'function') {
        this.store.recordRouting(workflow.id, {
          auditEvents: [
            buildRoutingAuditEvent({ event: 'ROUTE_REQUESTED', sessionRef: workflow.binding && workflow.binding.sessionRef, routeDecision: request, now: this.now() }),
            buildRoutingAuditEvent({ event: 'MODEL_APPLY_STARTED', sessionRef: workflow.binding && workflow.binding.sessionRef, routeDecision: request, now: this.now() }),
          ],
        });
      }
    }
    try {
      const outcome = await this.routingRuntime.prepare(context);
      if (trackApply) {
        const decision = outcome && outcome.decision || {};
        const profileResult = outcome && outcome.profileResult || null;
        const applying = decision.action === 'apply';
        const profile = decision.resolvedProfile || (profileResult && profileResult.readback) || null;
        this.store.appendWal(workflow.id, {
          operationId, kind: 'profile_apply', attempt: Number(workflow.runCount || 0) + 1,
          state: applying && (!profileResult || profileResult.ok !== true) ? 'reconcile_required' : 'committed',
          phase: applying ? (profileResult && profileResult.ok === true ? 'MODEL_APPLY_VERIFIED' : 'MODEL_APPLY_FAILED') : 'ROUTE_RESOLVED',
          sendAttempted: false, routeRequest: decision.routeRequest, resolvedProfile: profile,
          reasonCode: profileResult && profileResult.code || decision.reasonCode,
        });
      }
      return outcome;
    } catch (error) {
      if (trackApply) {
        this.store.appendWal(workflow.id, {
          operationId, kind: 'profile_apply', attempt: Number(workflow.runCount || 0) + 1,
          state: 'reconcile_required', phase: 'MODEL_APPLY_FAILED', sendAttempted: false,
          routeRequest: request.routeRequest, reasonCode: 'PROFILE_APPLY_FAILED',
        });
        return {
          decision: { ...request, action: 'pause', reasonCode: 'PROFILE_APPLY_FAILED' },
          profileResult: { ok: false, code: 'PROFILE_APPLY_FAILED' },
          error: 'routing profile apply failed',
        };
      }
      return {
        decision: { enabled: true, action: 'continue', reasonCode: 'ROUTING_RUNTIME_FAILED', routeRequest: null, resolvedProfile: null },
        profileResult: null,
        error: 'routing runtime failed',
      };
    }
  }

  recordRoutingOutcome(workflow, outcome) {
    const decision = outcome.decision || {};
    const request = decision.routeRequest || {};
    const resolved = decision.resolvedProfile || {};
    const applied = outcome.profileResult || {};
    const readback = applied.readback || {};
    const summary = {
      enabled: decision.enabled === true,
      action: String(decision.action || ''),
      reasonCode: String(decision.reasonCode || ''),
      complexityTier: String(request.complexityTier || resolved.complexityTier || ''),
      thinkingTier: String(request.thinkingTier || resolved.thinkingTier || ''),
      promptPolicy: String(request.promptPolicy || resolved.promptPolicy || ''),
      modelId: String(readback.modelId || resolved.modelId || ''),
      reasoningLevel: String(readback.reasoningLevel || resolved.reasoningLevel || ''),
      source: String(applied.source || ''),
      verified: applied.verified === true,
      fallbackApplied: applied.fallbackApplied === true || resolved.fallbackApplied === true,
      catalogSource: String((decision.catalog && decision.catalog.source) || request.catalogSource || ''),
      catalogStale: Boolean((decision.catalog && decision.catalog.stale) || request.catalogStale),
    };
    const auditEvents = [];
    if (decision.routeRequest || decision.resolvedProfile) {
      auditEvents.push(buildRoutingAuditEvent({
        event: 'ROUTE_RESOLVED', sessionRef: workflow.binding && workflow.binding.sessionRef,
        routeDecision: decision, profileResult: applied, now: this.now(),
      }));
    }
    if (decision.reasonCode === 'ROUTE_ESCALATED' || decision.reasonCode === 'ROUTE_DOWNGRADED') {
      auditEvents.push(buildRoutingAuditEvent({
        event: decision.reasonCode, sessionRef: workflow.binding && workflow.binding.sessionRef,
        routeDecision: decision, profileResult: applied, now: this.now(),
      }));
    }
    if (decision.reasonCode === 'ROUTING_UNAVAILABLE' || decision.reasonCode === 'ROUTING_AGENT_UNSUPPORTED'
      || decision.reasonCode === 'ROUTING_RUNTIME_FAILED' || decision.reasonCode === 'PROFILE_APPLY_FAILED') {
      auditEvents.push(buildRoutingAuditEvent({
        event: 'ROUTE_FALLBACK', sessionRef: workflow.binding && workflow.binding.sessionRef,
        routeDecision: decision, profileResult: applied, now: this.now(),
      }));
    }
    if (decision.action === 'apply') {
      auditEvents.push(buildRoutingAuditEvent({
        event: applied.ok === true ? 'MODEL_APPLY_VERIFIED' : 'MODEL_APPLY_FAILED',
        sessionRef: workflow.binding && workflow.binding.sessionRef,
        routeDecision: decision, profileResult: applied, now: this.now(),
      }));
      auditEvents.push(buildRoutingAuditEvent({
        event: applied.ok === true ? 'PROFILE_VERIFIED' : 'PROFILE_UNVERIFIED',
        sessionRef: workflow.binding && workflow.binding.sessionRef,
        routeDecision: decision, profileResult: applied, now: this.now(),
      }));
      if (applied.ok === true && (readback.reasoningLevel || resolved.reasoningLevel)) {
        auditEvents.push(buildRoutingAuditEvent({
          event: 'REASONING_APPLY_VERIFIED', sessionRef: workflow.binding && workflow.binding.sessionRef,
          routeDecision: decision, profileResult: applied, now: this.now(),
        }));
      }
    }
    if (Array.isArray(outcome.auditEvents)) auditEvents.push(...outcome.auditEvents);
    if (outcome.auditEvent) auditEvents.push(outcome.auditEvent);
    let current = this.store.recordRouting(workflow.id, { summary, auditEvents });
    if (decision.action === 'apply' && applied.ok === true && typeof this.store.acceptTurn === 'function') {
      const acceptedProfile = resolved.modelId || readback.modelId ? {
        modelId: readback.modelId || resolved.modelId,
        reasoningLevel: readback.reasoningLevel || resolved.reasoningLevel,
      } : null;
      if (acceptedProfile) {
        current = this.store.acceptTurn(workflow.id, {
          turnId: 'turn-' + (Number(workflow.runCount || 0) + 1),
          attempt: Number(workflow.runCount || 0) + 1,
          routeRequest: request,
          resolvedProfile: acceptedProfile,
          verification: { verified: true, source: applied.source, resultCode: applied.code },
        });
      }
    }
    return current;
  }

  async preflightSession(workflow, dependencies) {
    return runPreflightSession({ workflow, dependencies });
  }

  async captureDeliveryBoundary(session, dependencies) {
    if (!session || !dependencies || typeof dependencies.captureDeliverySnapshot !== 'function') return null;
    try {
      const snapshot = await dependencies.captureDeliverySnapshot(session, { phase: 'PRE_DISPATCH' });
      return snapshot === undefined || snapshot === null ? null : snapshot;
    } catch { return null; }
  }

  handoffView(workflow, state = currentHandoffStep(workflow)) {
    if (!state || !state.step) return workflow;
    const step = state.step;
    const contract = workflow.runContract || {};
    return {
      ...workflow,
      agent: step.agent,
      binding: {
        ...(workflow.binding || {}),
        agent: step.agent,
        projectPath: workflow.projectPath,
        ...(step.sessionRef ? { sessionRef: step.sessionRef } : {}),
      },
      runContract: {
        ...contract,
        goal: step.goal,
        goalSummary: step.goal,
        scope: contract.scope || { inScope: [], outOfScope: [] },
        verify: { dod: [...step.dod], evidence: step.evidence.length ? [...step.evidence] : [...step.dod] },
      },
    };
  }

  async prepareHandoffStep(workflow) {
    const state = currentHandoffStep(workflow);
    if (!state) return { workflow, state: null };
    if (state.complete) return { workflow, state };
    if (state.blocked) return { workflow, state, error: { code: 'HANDOFF_DEPENDENCY_BLOCKED', reason: `依赖步骤尚未完成：${state.missingDependencies.join('、')}` } };
    const step = state.step;
    if (['need_human', 'paused', 'failed', 'blocked'].includes(step.status)) {
      return { workflow, state, error: { code: step.status === 'need_human' ? 'HANDOFF_NEED_HUMAN' : 'HANDOFF_STEP_PAUSED', reason: '当前 handoff step 已暂停，等待人工处理' } };
    }
    if (['required', 'unresolved', 'researching'].includes(step.researchState && step.researchState.status)) {
      const researched = await this.researchHandoffStep(workflow, state);
      if (researched.error) return researched;
      workflow = researched.workflow;
      return { workflow, state: currentHandoffStep(workflow) };
    }
    const contract = workflow.runContract || {};
    const budget = contract.budget || {};
    if (Number(budget.maxBudget) > 0 && Number(workflow.budgetUsed || 0) >= Number(budget.maxBudget)) {
      return { workflow, state, error: { code: 'BUDGET_EXCEEDED', reason: '整个 handoffChain 已达到总预算' }, terminal: true };
    }
    const maxStepRuntime = Number.isInteger(budget.maxStepRuntime) ? budget.maxStepRuntime : DEFAULT_MAX_STEP_RUNTIME;
    if (step.startedAt !== null && Number.isFinite(step.startedAt) && this.now() - step.startedAt >= maxStepRuntime) {
      return { workflow, state, error: { code: 'STEP_TIMEOUT', reason: '当前 handoff step 已超过单步超时' }, terminal: true };
    }
    const maxRetries = Number.isInteger(budget.maxRetries) ? budget.maxRetries : DEFAULT_MAX_RETRIES;
    if (step.attempts > maxRetries) {
      return { workflow, state, error: { code: 'RETRY_LIMIT_EXCEEDED', reason: '当前 handoff step 已达到最大重试次数' }, terminal: true };
    }
    let sessionRef = step.sessionRef;
    const boundAgent = String(workflow.binding && workflow.binding.agent || workflow.agent || '').trim().toLowerCase();
    if (!sessionRef && state.step.order === 1 && workflow.binding && workflow.binding.sessionRef && boundAgent === step.agent) {
      sessionRef = workflow.binding.sessionRef;
    }
    if (!sessionRef) {
      try {
        const provisioner = this.sessionProvisioners instanceof Map
          ? this.sessionProvisioners.get(step.agent) : this.sessionProvisioners[step.agent];
        if (!provisioner || provisioner.supported !== true || typeof provisioner.create !== 'function') {
          return { workflow, state, error: { code: 'SESSION_CREATION_UNAVAILABLE', reason: `Agent（${step.agent}）没有可靠的真实 Session 创建能力` } };
        }
        const session = await provisioner.create({ projectPath: workflow.projectPath, title: step.goal });
        if (!session || session.agent !== step.agent || !String(session.sessionRef || '').trim()) {
          return { workflow, state, error: { code: 'SESSION_CREATION_UNVERIFIED', reason: 'Agent 未返回可验证的真实 Session' } };
        }
        sessionRef = String(session.sessionRef).trim();
      } catch (error) {
        return { workflow, state, error: { code: error.code || 'SESSION_CREATION_UNAVAILABLE', reason: '无法创建下一步真实 Session' } };
      }
    }
    if (sessionRef !== step.sessionRef && typeof this.store.updateHandoffStep === 'function') {
      workflow = this.store.updateHandoffStep(workflow.id, step.id, { sessionRef });
      return { workflow, state: currentHandoffStep(workflow) };
    }
    return { workflow, state };
  }

  async researchHandoffStep(workflow, state) {
    if (!this.researcher || !state || !state.step) {
      return { workflow, state, error: { code: 'HANDOFF_RESEARCH_REQUIRED', reason: '当前 handoff step 尚未完成只读研究，无法安全执行' } };
    }
    const step = state.step;
    const currentResearch = normalizeResearchState(step.researchState);
    let researching = this.store.updateHandoffStep(workflow.id, step.id, {
      researchState: { ...currentResearch, status: 'researching', attempts: currentResearch.attempts + 1 },
    });
    try {
      const result = await this.researcher.research({
        projectPath: workflow.projectPath, allowedRoots: this.allowedRoots, goal: step.goal,
        fields: ['goal', 'dod', 'evidence'], permissionSnapshot: workflow.permissionSnapshot,
        attempts: currentResearch.attempts,
      });
      const research = normalizeResearchState({ ...result, attempts: Math.max(currentResearch.attempts + 1, Number(result && result.attempts) || 0) });
      researching = this.store.updateHandoffStep(workflow.id, step.id, { researchState: research });
      if (research.status === 'completed') return { workflow: researching, state: currentHandoffStep(researching) };
      const needsHuman = ['permission_required', 'conflict', 'timeout', 'budget_exceeded'].includes(research.status);
      return {
        workflow: researching, state: currentHandoffStep(researching),
        error: { code: research.errorCode || (needsHuman ? 'HANDOFF_NEED_HUMAN' : 'HANDOFF_RESEARCH_REQUIRED'), reason: research.needsHumanReason || '当前 handoff step 的研究尚未得到可验证结论' },
        terminal: ['timeout', 'budget_exceeded'].includes(research.status),
      };
    } catch {
      const failed = this.store.updateHandoffStep(workflow.id, step.id, {
        researchState: { ...currentResearch, status: 'failed', attempts: currentResearch.attempts + 1, errorCode: 'RESEARCH_PROVIDER_UNAVAILABLE' },
      });
      return { workflow: failed, state: currentHandoffStep(failed), error: { code: 'HANDOFF_RESEARCH_REQUIRED', reason: '只读研究服务不可用，已暂停当前步骤' } };
    }
  }

  async prepareWorkflowResearch(workflow) {
    if (!this.researcher || !workflow.taskContract || typeof this.store.updateResearchState !== 'function') {
      return { workflow, error: { code: 'RESEARCH_REQUIRED', reason: 'Task Contract 尚未完成只读研究，无法安全执行' } };
    }
    const current = normalizeResearchState(workflow.researchState);
    const researching = this.store.updateResearchState(workflow.id, {
      ...current, status: 'researching', attempts: current.attempts + 1,
    });
    try {
      const result = await this.researcher.research({
        projectPath: workflow.projectPath, allowedRoots: this.allowedRoots, goal: workflow.taskContract.goal,
        fields: workflow.taskContract.researchableFields, permissionSnapshot: workflow.permissionSnapshot,
        attempts: current.attempts,
      });
      const research = normalizeResearchState({ ...result, attempts: Math.max(current.attempts + 1, Number(result && result.attempts) || 0) });
      let updated = this.store.updateResearchState(workflow.id, research);
      if (research.status !== 'completed') {
        return { workflow: updated, error: { code: research.errorCode || 'RESEARCH_REQUIRED', reason: research.needsHumanReason || 'Task Contract 研究尚未得到可验证结论' } };
      }
      const contract = mergeResearchIntoTaskContract(workflow.taskContract, research);
      if (contract.generationStatus !== 'ready') return { workflow: updated, error: { code: 'RESEARCH_REQUIRED', reason: 'Task Contract 研究完成但仍有未决字段' } };
      const runContract = normalizeRunContract({
        ...workflow.runContract,
        goal: contract.goal,
        goalSummary: contract.goalSummary || contract.goal,
        scope: { inScope: contract.inScope, outOfScope: contract.outOfScope },
        verify: { dod: contract.dod, evidence: contract.evidence },
      });
      updated = this.store.updateFields(workflow.id, { taskContract: contract, runContract, researchState: research }, 'research_completed');
      return { workflow: updated };
    } catch {
      const failed = this.store.updateResearchState(workflow.id, {
        ...current, status: 'failed', attempts: current.attempts + 1, errorCode: 'RESEARCH_PROVIDER_UNAVAILABLE',
      });
      return { workflow: failed, error: { code: 'RESEARCH_PROVIDER_UNAVAILABLE', reason: '只读研究服务不可用，已暂停任务' } };
    }
  }

  activateHandoffStep(workflow, state) {
    if (!state || !state.step) return workflow;
    const step = state.step;
    const previousBinding = workflow.binding || {};
    const binding = {
      ...(previousBinding.title ? { title: previousBinding.title } : {}),
      agent: step.agent,
      projectPath: workflow.projectPath,
      sessionRef: step.sessionRef || (workflow.binding && workflow.binding.sessionRef) || '',
      ...(String(workflow.agent || '').trim().toLowerCase() === step.agent && previousBinding.transport
        ? { transport: previousBinding.transport } : {}),
    };
    return this.store.updateFields(workflow.id, {
      agent: step.agent,
      binding,
    }, 'handoff_step_activated');
  }

  pauseHandoff(workflow, state, error, terminal = false) {
    let current = workflow;
    if (state && state.step && typeof this.store.updateHandoffStep === 'function') {
      const status = error.code === 'HANDOFF_NEED_HUMAN' || String(error.code || '').includes('NEED_HUMAN')
        ? 'need_human' : 'paused';
      current = this.store.updateHandoffStep(current.id, state.step.id, {
        status, result: { code: error.code, reason: error.reason },
      });
    }
    const deliveryUnverified = ['DELIVERY_UNVERIFIED', 'SEND_UNCERTAIN'].includes(error.code);
    const blocked = ['BUDGET_EXCEEDED', 'RETRY_LIMIT_EXCEEDED'].includes(error.code);
    const researchBudgetExceeded = ['RESEARCH_TIMEOUT', 'RESEARCH_BUDGET_EXCEEDED', 'RESEARCH_SOURCE_LIMIT'].includes(error.code);
    const reason = terminal && error.code === 'STEP_TIMEOUT' ? 'Step Timeout'
      : deliveryUnverified ? 'Delivery Unverified'
        : blocked || researchBudgetExceeded ? 'Budget Exceeded' : 'Need Human';
    current = this.store.updateFields(current.id, { lastError: error.code, stopReason: reason }, 'handoff_blocked');
    return this.finish(current, terminal ? 'STOPPED' : 'PAUSED', reason, null, error.code);
  }

  markHandoffStepDone(workflow, state, decision, progress) {
    if (!state || !state.step || typeof this.store.updateHandoffStep !== 'function') return workflow;
    let current = this.store.updateHandoffStep(workflow.id, state.step.id, {
      status: 'done', completedAt: this.now(),
      result: { status: 'done', summary: decision && decision.summary || 'Supervisor 已判定完成' },
      evidenceSnapshot: {
        verified: true, completed: true, deliveryVerified: true,
        passed: Number(progress && progress.completed || 0), total: Number(progress && progress.total || state.step.dod.length), source: 'supervisor',
      },
    });
    const next = currentHandoffStep(current);
    if (next && !next.complete) {
      if (current.autoState !== 'WAITING_AGENT') current = this.store.transitionState(current.id, 'WAITING_AGENT', 'handoff_step_done');
      return current;
    }
    return current;
  }

  async readSessionSnapshot(workflow, dependencies, preflightSession) {
    if (preflightSession && Array.isArray(preflightSession.messages)) return preflightSession;
    if (!dependencies || typeof dependencies.readSession !== 'function') return preflightSession;
    try {
      return await dependencies.readSession(workflow && workflow.binding && workflow.binding.sessionRef);
    } catch { return preflightSession; }
  }

  observeHostedReply(workflow, session) {
    const control = normalizeHostedControl(workflow && workflow.hostedControl);
    const reply = control.enabled ? classifyHostedAgentReply({ messages: session && session.messages }) : {
      status: 'unknown', requiresHostDecision: false, safetyBoundary: false,
      messageId: '', messageAt: null, summary: '', reasonCode: '',
    };
    if (!control.enabled || !reply.messageId || control.lastAgentMessageId === reply.messageId) {
      return { workflow, reply, fresh: false };
    }
    const latest = typeof this.store.listDispatchRecords === 'function'
      ? this.store.listDispatchRecords(workflow.id).slice(-1)[0] : null;
    if (reply.messageAt !== null && latest) {
      const startedAt = latest.startedAt === null || latest.startedAt === undefined ? null : Number(latest.startedAt);
      const completedAt = latest.completedAt === null || latest.completedAt === undefined ? null : Number(latest.completedAt);
      const isCurrentDispatchReply = Number.isFinite(startedAt) && reply.messageAt >= startedAt;
      if (!isCurrentDispatchReply && Number.isFinite(completedAt) && reply.messageAt < completedAt) {
        return { workflow, reply, fresh: false };
      }
    }
    const updated = this.store.updateFields(workflow.id, {
      hostedControl: {
        ...control,
        lastAgentMessageId: reply.messageId,
        lastAgentMessageStatus: reply.status,
        lastAgentMessageAt: reply.messageAt,
        blockedReason: reply.status === 'blocked' ? reply.reasonCode : '',
      },
    }, 'hosted_agent_reply_observed');
    return { workflow: updated, reply, fresh: true };
  }

  completionDetector(dependencies, workflow) {
    if (dependencies && dependencies.completionDetector
      && typeof dependencies.completionDetector.detect === 'function') return dependencies.completionDetector;
    if (typeof this.resolveCompletionDetector !== 'function') return null;
    try {
      const detector = this.resolveCompletionDetector(workflow && workflow.agent, workflow);
      return detector && typeof detector.detect === 'function' ? detector : null;
    } catch { return null; }
  }

  async detectCompletion(workflow, dependencies) {
    const latest = typeof this.store.listDispatchRecords === 'function'
      ? this.store.listDispatchRecords(workflow.id).slice(-1)[0] : null;
    if (!latest || latest.state !== 'committed' || latest.sessionRef !== (workflow.binding && workflow.binding.sessionRef)) {
      return { status: 'unknown', completed: false, reasonCode: 'DISPATCH_RECORD_UNAVAILABLE' };
    }
    if (workflow.lastCompletionDispatchId && workflow.lastCompletionDispatchId === latest.id) {
      return { status: 'already_observed', completed: false, reasonCode: 'COMPLETION_ALREADY_OBSERVED' };
    }
    const detector = this.completionDetector(dependencies, workflow);
    if (!detector) return { status: 'unknown', completed: false, reasonCode: 'COMPLETION_DETECTOR_UNAVAILABLE' };
    try {
      const result = await detector.detect({
        workflow, dispatchRecord: latest, now: this.now(),
      });
      return result && typeof result === 'object' ? { ...result, dispatchRecordId: latest.id } : {
        status: 'unknown', completed: false, reasonCode: 'INVALID_COMPLETION_RESULT', dispatchRecordId: latest.id,
      };
    } catch {
      return { status: 'unknown', completed: false, reasonCode: 'COMPLETION_DETECTOR_FAILED', dispatchRecordId: latest.id };
    }
  }

  async collectEvidence(workflow) {
    if (typeof this.evidenceCollector !== 'function' || !workflow || Number(workflow.runCount || 0) < 1) return workflow;
    try {
      const result = await this.evidenceCollector({ workflow });
      if (!result || typeof result !== 'object') return workflow;
      return this.store.updateFields(workflow.id, { lastEvidence: result }, 'evidence_collected');
    } catch {
      return workflow;
    }
  }

  recordCompletionEvidence(workflow, detection) {
    const evidence = Array.isArray(detection && detection.evidence)
      ? detection.evidence : detection && detection.evidence ? [detection.evidence] : [];
    let current = workflow;
    for (const item of evidence) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      current = this.store.recordEvidence(current.id, item);
    }
    return this.store.updateFields(current.id, {
      lastCompletionDispatchId: detection.dispatchRecordId,
    }, 'completion_detected');
  }

  reconciliationDue(workflow) {
    if (!workflow || workflow.runCount < 1) return false;
    const last = Number.isInteger(workflow.lastReconciledRunCount) ? workflow.lastReconciledRunCount : 0;
    return workflow.runCount - last >= this.reconcileEveryTurns;
  }

  async performPeriodicReconciliation(workflow, dependencies, session = null) {
    const contract = workflow && workflow.runContract || {};
    const binding = workflow && workflow.binding || {};
    const progress = calculateProgress({ workflow, now: this.now() });
    const latestRecord = typeof this.store.listDispatchRecords === 'function'
      ? this.store.listDispatchRecords(workflow.id).slice(-1)[0] : null;
    const routing = workflow && workflow.lastRouting || {};
    const checks = [
      { name: 'goal', status: typeof contract.goal === 'string' && contract.goal.trim() ? 'pass' : 'fail' },
      { name: 'scope', status: binding.projectPath && String(binding.projectPath).toLowerCase() === String(workflow.projectPath || '').toLowerCase()
        && (!this.allowedRoots.length || this.allowedRoots.some((root) => isInsideRoot(binding.projectPath, root))) ? 'pass' : 'fail' },
      { name: 'dod', status: Array.isArray(contract.verify?.dod) && contract.verify.dod.length ? 'pass' : 'fail' },
      { name: 'session_binding', status: session && session.strongAnchor === true
        && session.sessionRef === binding.sessionRef ? 'pass' : 'fail' },
      { name: 'actual_conversation', status: latestRecord?.state === 'committed'
        && latestRecord.deliveryProof?.verified === true && latestRecord.deliveryProof?.delivered === true ? 'pass' : 'fail' },
      { name: 'current_profile', status: workflow.routingConfig?.enabled !== true ? 'not_required'
        : routing.verified === true ? 'pass'
          : ['ROUTING_UNAVAILABLE', 'ROUTING_AGENT_UNSUPPORTED', 'ROUTING_RUNTIME_FAILED'].includes(routing.reasonCode) ? 'degraded' : 'fail' },
      { name: 'model_catalog_version', status: workflow.routingConfig?.enabled !== true ? 'not_required'
        : routing.catalogSource ? (routing.catalogStale ? 'degraded' : 'pass') : 'degraded' },
      { name: 'progress', status: progress.status === 'blocked' ? 'fail' : 'pass' },
    ];
    const failed = checks.find((check) => check.status === 'fail');
    return {
      ok: !failed,
      reasonCode: failed ? String(failed.name || 'RECONCILIATION_FAILED').toUpperCase() + '_DRIFT' : 'RECONCILIATION_OK',
      stopReason: failed && failed.name === 'actual_conversation' ? 'Delivery Unverified'
        : failed && failed.name === 'current_profile' ? 'Profile Apply Unverified' : 'Identity Unverified',
      report: {
        version: 1, runCount: workflow.runCount, checkedAt: this.now(), ok: !failed,
        checks,
      },
    };
  }

  async reconcileAfterTurn(workflow, dependencies, session, decision) {
    if (!this.reconciliationDue(workflow) || ['DONE', 'STOPPED', 'PAUSED', 'BLOCKED'].includes(workflow.autoState)) return workflow;
    const result = await this.performPeriodicReconciliation(workflow, dependencies, session);
    let current = this.store.updateFields(workflow.id, {
      lastReconciledRunCount: workflow.runCount,
      lastReconciledAt: this.now(),
      lastReconciliation: result.report,
    }, result.ok ? 'periodic_reconciled' : 'periodic_reconciliation_failed');
    if (!result.ok) {
      current = this.finish(current, 'PAUSED', result.stopReason, decision, result.reasonCode);
    }
    return current;
  }

  async readProfileForRecovery(workflow, entry, dependencies) {
    const input = {
      workflow, entry, dependencies,
      sessionRef: workflow.binding && workflow.binding.sessionRef,
      profile: entry.resolvedProfile,
    };
    const readers = [];
    if (typeof this.profileReader === 'function') readers.push(this.profileReader);
    if (this.routingRuntime && typeof this.routingRuntime.reconcileProfile === 'function') {
      readers.push(this.routingRuntime.reconcileProfile.bind(this.routingRuntime));
    }
    if (this.routingRuntime && typeof this.routingRuntime.readProfile === 'function') {
      readers.push(this.routingRuntime.readProfile.bind(this.routingRuntime));
    }
    if (dependencies && typeof dependencies.readProfile === 'function') readers.push(dependencies.readProfile);
    if (dependencies && dependencies.profileReader && typeof dependencies.profileReader.read === 'function') {
      readers.push(dependencies.profileReader.read.bind(dependencies.profileReader));
    }
    for (const reader of readers) {
      try {
        const result = await reader(input);
        const readback = result && result.readback || result && result.profile || result;
        if (readback && typeof readback === 'object' && !Array.isArray(readback)) {
          return { readback, source: result && result.source };
        }
      } catch { /* recovery remains fail closed when no exact readback is available */ }
    }
    return null;
  }

  async reconcileProfileApply(workflow, dependencies) {
    if (!workflow || typeof this.store.listPendingWal !== 'function') return workflow;
    const pending = this.store.listPendingWal(workflow.id)
      .filter((entry) => entry.kind === 'profile_apply' || String(entry.phase || '').includes('APPLY'));
    if (!pending.length) return workflow;
    const entry = pending[pending.length - 1];
    const expected = entry.resolvedProfile;
    const actual = expected ? await this.readProfileForRecovery(workflow, entry, dependencies) : null;
    const readback = actual && actual.readback || null;
    const modelMatches = Boolean(expected && readback
      && String(expected.modelId || '') === String(readback.modelId || ''));
    const reasoningMatches = !expected || !expected.reasoningLevel
      || String(expected.reasoningLevel).toLowerCase() === String(readback && readback.reasoningLevel || '').toLowerCase();
    const routeDecision = {
      enabled: true, action: 'apply', reasonCode: modelMatches && reasoningMatches ? 'PROFILE_VERIFIED' : 'PROFILE_UNVERIFIED',
      routeRequest: entry.routeRequest || {}, resolvedProfile: expected || {},
    };
    if (modelMatches && reasoningMatches && entry.routeRequest) {
      this.store.appendWal(workflow.id, {
        ...entry, kind: 'profile_apply', state: 'committed', phase: 'RECOVERY_VERIFY_PROFILE', sendAttempted: false,
        reasonCode: 'PROFILE_VERIFIED', routeRequest: entry.routeRequest, resolvedProfile: expected,
      });
      if (typeof this.store.acceptTurn === 'function') {
        try {
          this.store.acceptTurn(workflow.id, {
            turnId: 'turn-' + (Number.isInteger(entry.attempt) ? entry.attempt : Number(workflow.runCount || 0) + 1),
            attempt: Number.isInteger(entry.attempt) ? entry.attempt : Number(workflow.runCount || 0) + 1,
            routeRequest: entry.routeRequest,
            resolvedProfile: expected,
            verification: { verified: true, source: actual.source || 'reconciliation' },
          });
        } catch { return this.failProfileReconciliation(workflow, entry, routeDecision, 'PROFILE_UNVERIFIED'); }
      }
      if (typeof this.store.recordRouting === 'function') {
        this.store.recordRouting(workflow.id, {
          auditEvents: [
            buildRoutingAuditEvent({ event: 'MODEL_APPLY_VERIFIED', sessionRef: workflow.binding && workflow.binding.sessionRef, routeDecision, profileResult: { ...actual, ok: true, verified: true }, now: this.now() }),
            buildRoutingAuditEvent({ event: 'PROFILE_VERIFIED', sessionRef: workflow.binding && workflow.binding.sessionRef, routeDecision, profileResult: { ...actual, ok: true, verified: true }, now: this.now() }),
          ],
        });
      }
      return this.store.updateFields(workflow.id, { profileApplyReconciled: true, stopReason: null, lastError: '' }, 'profile_reconciled');
    }
    return this.failProfileReconciliation(workflow, entry, routeDecision, !expected ? 'PROFILE_APPLY_FAILED' : 'PROFILE_VERIFY_FAILED');
  }

  failProfileReconciliation(workflow, entry, routeDecision, reasonCode) {
    this.store.appendWal(workflow.id, {
      ...entry, kind: 'profile_apply', state: 'reconcile_required', phase: 'RECOVERY_VERIFY_PROFILE', sendAttempted: false,
      reasonCode, routeRequest: entry.routeRequest, resolvedProfile: entry.resolvedProfile,
    });
    if (typeof this.store.recordRouting === 'function') {
      this.store.recordRouting(workflow.id, {
        auditEvents: [
          buildRoutingAuditEvent({ event: 'MODEL_APPLY_FAILED', sessionRef: workflow.binding && workflow.binding.sessionRef, routeDecision, profileResult: { code: reasonCode }, now: this.now() }),
          buildRoutingAuditEvent({ event: 'PROFILE_UNVERIFIED', sessionRef: workflow.binding && workflow.binding.sessionRef, routeDecision, profileResult: { code: reasonCode }, now: this.now() }),
          buildRoutingAuditEvent({ event: 'PROFILE_APPLY_FAILED', sessionRef: workflow.binding && workflow.binding.sessionRef, routeDecision, profileResult: { code: reasonCode }, now: this.now() }),
        ],
      });
    }
    let current = this.store.updateFields(workflow.id, {
      profileApplyReconciled: false, stopReason: 'Profile Apply Unverified', lastError: 'profile apply reconciliation failed',
    }, 'profile_reconcile_failed');
    if (!['PAUSED', 'BLOCKED', 'DONE', 'STOPPED'].includes(current.autoState)) {
      current = this.store.transitionState(workflow.id, 'PAUSED', 'profile_reconcile_paused');
    }
    return current;
  }

  async reconcileOnce(id) {
    let workflow = this.store.get(id);
    if (!workflow) return null;
    if (workflow.autopilotMode === 'auto' && workflow.autoState === 'OFF') {
      const pendingWal = typeof this.store.listPendingWal === 'function' ? this.store.listPendingWal(id) : [];
      if (!pendingWal.length) return this.runOnce(id);
    }
    const handoffEnabled = Array.isArray(workflow.handoffChain) && workflow.handoffChain.length > 0;
    const refreshExecutionView = (candidate) => handoffEnabled
      ? this.handoffView(candidate, currentHandoffStep(candidate)) : candidate;
    const initialHandoffState = handoffEnabled ? currentHandoffStep(workflow) : null;
    if (handoffEnabled && initialHandoffState) {
      if (initialHandoffState.complete) {
        return workflow.autoState === 'DONE'
          ? this.notify(workflow)
          : this.finish(workflow, 'DONE', 'DoD Complete', workflow.lastDecision || null);
      }
      if (initialHandoffState.step && ['need_human', 'paused', 'failed', 'blocked'].includes(initialHandoffState.step.status)) {
        return this.notify(workflow);
      }
      workflow = refreshExecutionView(workflow);
    }
    const dependencies = typeof this.resolveDependencies === 'function' ? this.resolveDependencies(workflow.agent, workflow) : null;
    workflow = await this.reconcileProfileApply(workflow, dependencies);
    workflow = refreshExecutionView(workflow);
    if (workflow.stopReason === 'Profile Apply Unverified') return this.notify(this.store.get(id) || workflow);
    const result = await reconcilePendingDispatch({
      store: this.store, workflowId: id,
      verifyDelivery: async (entry) => {
        if (!dependencies || typeof dependencies.resolveSession !== 'function' || typeof dependencies.verifySession !== 'function'
          || typeof dependencies.verifyDelivery !== 'function') return null;
        const binding = workflow.binding || {};
        const request = { agent: workflow.agent, project: binding.projectPath, sessionRef: binding.sessionRef, message: entry.instruction || '' };
        const resolution = await dependencies.resolveSession(request, { phase: 'RECOVERY' });
        const target = enrichVerifiedTarget(request, resolution);
        if (!target) return null;
        const verification = await dependencies.verifySession(target, { request, resolution, phase: 'RECOVERY' });
        if (!verification || verification.strongAnchor !== true) return null;
        if (typeof dependencies.verifyDeliveryFingerprint === 'function' && entry.instructionFingerprint) {
          return dependencies.verifyDeliveryFingerprint(target, entry.instructionFingerprint, {
            phase: 'RECOVERY', verification, snapshot: entry.deliverySnapshot || null,
          });
        }
        return dependencies.verifyDelivery(target, entry.instruction || '', { phase: 'RECOVERY', verification });
      },
    });
    workflow = refreshExecutionView(this.store.get(id) || result);
    workflow = await this.collectEvidence(workflow);
    workflow = refreshExecutionView(this.store.get(id) || workflow);
    const nativeTurn = isNativeTurn(workflow, dependencies);
    const sessionSnapshot = nativeTurn
      ? await this.readSessionSnapshot(workflow, dependencies, null)
      : await this.preflightSession(workflow, dependencies);
    const hostedObservation = this.observeHostedReply(workflow, sessionSnapshot);
    workflow = refreshExecutionView(hostedObservation.workflow);
    const hostedReply = hostedObservation.reply;
    const hostedControl = normalizeHostedControl(workflow.hostedControl);
    const hostedNeedsDecision = hostedControl.enabled
      && hostedReply.status === 'question'
      && hostedControl.lastAgentMessageId
      && hostedControl.lastAgentMessageId !== hostedControl.lastHandledAgentMessageId;
    const hostedReplyProgressed = hostedObservation.fresh
      && ['working', 'completed'].includes(hostedReply.status);
    if (hostedObservation.fresh && hostedReply.status === 'blocked' && hostedReply.realSafetyBoundary === true) {
      const state = hostedReply.safetyBoundary ? 'PAUSED' : 'BLOCKED';
      return this.notify(this.finish(workflow, state, hostedReply.safetyBoundary ? 'Need Human' : 'Blocked', workflow.lastDecision, hostedReply.reasonCode));
    }
    if (hostedObservation.fresh && hostedReply.status === 'waiting_for_host') {
      return this.notify(this.finish(workflow, 'PAUSED', 'Need Human', workflow.lastDecision, 'HOST_DECISION_REQUIRED'));
    }
    let progress = calculateProgress({ workflow, now: this.now() });
    workflow = this.store.updateFields(id, { progress }, 'reconciled');
    workflow = refreshExecutionView(workflow);
    if (this.reconciliationDue(workflow) && !['DONE', 'STOPPED', 'PAUSED', 'BLOCKED'].includes(workflow.autoState)) {
      workflow = await this.reconcileAfterTurn(workflow, dependencies, sessionSnapshot, workflow.lastDecision);
      if (['PAUSED', 'BLOCKED', 'DONE', 'STOPPED'].includes(workflow.autoState)) return this.notify(this.store.get(id) || workflow);
    }
    if (progress.status === 'completed' && workflow.autoState !== 'DONE' && !hostedNeedsDecision) {
      return handoffEnabled
        ? this.runOnce(id)
        : this.finish(workflow, 'DONE', 'DoD Complete', workflow.lastDecision);
    }
    if (workflow.autopilotMode === 'auto' && workflow.autoState === 'WAITING_AGENT') {
      if (hostedNeedsDecision) {
        if (workflow.controlOwner === 'human') return this.notify(workflow);
        return this.runOnce(id);
      }
      const detection = await this.detectCompletion(workflow, dependencies);
      if (detection.completed === true && detection.status === 'completed') {
        workflow = refreshExecutionView(this.recordCompletionEvidence(workflow, detection));
        progress = calculateProgress({ workflow, now: this.now() });
        workflow = this.store.updateFields(id, { progress }, 'completion_progress_updated');
        workflow = refreshExecutionView(workflow);
        if (progress.status === 'completed') {
          return handoffEnabled
            ? this.runOnce(id)
            : this.finish(workflow, 'DONE', 'DoD Complete', workflow.lastDecision);
        }
        if (workflow.autoState === 'WAITING_AGENT' && workflow.controlOwner !== 'human') {
          return this.runOnce(id);
        }
      }
      const permissionWait = ['waiting_user', 'waiting_user_input', 'waiting_approval'].includes(detection.status)
        || detection.reasonCode === 'PERMISSION_REQUIRED';
      if (permissionWait) {
        if (hostedControl.enabled && hostedControl.lastAgentMessageId
          && hostedControl.lastAgentMessageId === hostedControl.lastHandledAgentMessageId) {
          return this.notify(workflow);
        }
        return this.finish(workflow, 'PAUSED', stopReason(detection.reasonCode, 'Need Human'), workflow.lastDecision, detection.reasonCode);
      }
      if (['blocked', 'failed'].includes(detection.status)) {
        return this.finish(workflow, 'BLOCKED', 'Blocked', workflow.lastDecision, detection.reasonCode);
      }
      if (hostedReplyProgressed) {
        if (workflow.controlOwner === 'human') return this.notify(workflow);
        return this.runOnce(id);
      }
    }
    return this.notify(this.store.get(id) || workflow);
  }

  reconcile(id) {
    return this.enqueue(id, () => this.reconcileOnce(id));
  }

  async reconcileAll() {
    const workflows = this.store.list().filter((workflow) => workflow.autopilotMode === 'auto');
    for (const workflow of workflows) {
      try {
        await this.reconcile(workflow.id);
      } catch {
        await this.recordMonitoringFailure(workflow.id, 'AUTOPILOT_TIMER_FAILED');
      }
    }
  }

  resume(id, owner = 'human') {
    let workflow = this.store.get(id);
    if (!workflow) return null;
    if (workflow.autoState !== 'PAUSED' && workflow.autoState !== 'BLOCKED') throw new Error('workflow is not paused or blocked');
    if (workflow.controlOwner && workflow.controlOwner !== owner && workflow.controlOwner === 'human') {
      throw new Error('workflow is controlled by another owner');
    }
    if (workflow.controlOwner) workflow = this.store.release(id, workflow.controlOwner);
    workflow = this.store.updateFields(id, { stopReason: null, lastError: '', lastInstructionFingerprint: '' }, 'resume_requested');
    return this.notify(this.store.transitionState(id, 'PREFLIGHT', 'resume_preflight'));
  }

  stop(id) {
    let workflow = this.store.get(id);
    if (!workflow) return null;
    if (workflow.autoState !== 'DONE' && workflow.autoState !== 'STOPPED') {
      workflow = this.store.updateFields(id, { stopReason: 'User Stop', endedAt: this.now() }, 'user_stop');
      workflow = this.store.transitionState(id, 'STOPPED', 'user_stop');
    }
    return this.notify(this.store.get(id) || workflow);
  }

  finish(workflow, state, reason, decision, error = '') {
    let current = this.store.get(workflow.id) || workflow;
    const fields = {
      stopReason: reason,
      ...(error ? { lastError: error } : {}),
      ...(state === 'DONE' || state === 'BLOCKED' || state === 'PAUSED' || state === 'STOPPED' ? { endedAt: this.now() } : {}),
    };
    current = this.store.updateFields(current.id, fields, 'auto_stopped');
    if (current.autoState !== state) current = this.store.transitionState(current.id, state, 'auto_stopped');
    const handoffCompleted = Array.isArray(current.handoffChain)
      ? current.handoffChain.filter((step) => step.status === 'done').length : 0;
    const progress = state === 'DONE' && current.handoffChain?.length
      ? { status: 'completed', completed: handoffCompleted, total: current.handoffChain.length, percent: 100, evidence: [] }
      : calculateProgress({ workflow: current, now: this.now() });
    current = this.store.updateFields(current.id, { progress }, 'progress_updated');
    const receipt = buildRunReceipt({ workflow: current, finalState: state, stopReason: reason, now: this.now(), decision });
    current = this.store.updateFields(current.id, { runReceipt: receipt }, 'run_receipt_created');
    if (current.controlOwner === this.owner) current = this.store.release(current.id, this.owner);
    return this.notify(this.store.get(current.id) || current);
  }

  startPeriodicReconciliation(intervalMs = 60_000) {
    if (this.timer) return this.stopPeriodicReconciliation.bind(this);
    const interval = Number(intervalMs);
    this.reconciliationIntervalMs = Number.isInteger(interval) && interval >= 1_000 && interval <= 3_600_000
      ? interval : 60_000;
    this.timer = setInterval(() => {
      this.reconcileAll().catch(() => { this.recordMonitoringFailureForActive('AUTOPILOT_TIMER_FAILED'); });
    }, this.reconciliationIntervalMs);
    this.timer.unref?.();
    return this.stopPeriodicReconciliation.bind(this);
  }

  stopPeriodicReconciliation() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = { AutoLoop, gateState, stopReason };
