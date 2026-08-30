'use strict';

const crypto = require('node:crypto');
const { dispatchVerifiedMessage } = require('../verified-dispatch');
const { enrichVerifiedTarget } = require('../verified-dispatch-target');
const { calculateProgress } = require('./progress');
const { buildSupervisorDecision, sanitizeSupervisorDecision } = require('./supervisor');
const { evaluatePolicyGate } = require('./policy-gate');
const { checkWatchdog } = require('./watchdog');
const { GuiBus } = require('./gui-bus');
const { buildRunReceipt } = require('./run-receipt');
const { reconcilePendingDispatch } = require('./reconciliation');

function errorFingerprint(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex').slice(0, 64);
}

function gateState(reasonCode) {
  return ['NEED_HUMAN', 'PERMISSION_REQUIRED', 'IDENTITY_UNVERIFIED', 'DELIVERY_UNVERIFIED', 'PROFILE_UNVERIFIED'].includes(reasonCode)
    ? 'PAUSED' : 'BLOCKED';
}

function stopReason(reasonCode, reason) {
  if (reasonCode === 'NEED_HUMAN' || reasonCode === 'PERMISSION_REQUIRED') return 'Need Human';
  if (reasonCode === 'IDENTITY_UNVERIFIED') return 'Identity Unverified';
  if (reasonCode === 'DUPLICATE_INSTRUCTION') return 'Stagnation';
  if (reasonCode === 'DELIVERY_UNVERIFIED') return 'Delivery Unverified';
  if (reasonCode === 'PROFILE_UNVERIFIED' || reasonCode === 'PROFILE_VERIFY_FAILED' || reasonCode === 'SESSION_DRIFT') return 'Profile Apply Unverified';
  if (reason === 'Budget Exceeded') return 'Budget Exceeded';
  if (reason === 'Stagnation') return 'Stagnation';
  return 'Blocked';
}

class AutoLoop {
  constructor({
    store, allowedRoots = [], resolveDependencies, resolveCompletionDetector, dispatch = dispatchVerifiedMessage,
    routingRuntime = null,
    guiBus = new GuiBus(), now = () => Date.now(), owner = 'autopilot', leaseMs = 60_000,
    onWorkflowChange,
  } = {}) {
    if (!store || typeof store.get !== 'function') throw new TypeError('workflow store is required');
    this.store = store;
    this.allowedRoots = allowedRoots;
    this.resolveDependencies = resolveDependencies;
    this.resolveCompletionDetector = resolveCompletionDetector;
    this.dispatch = dispatch;
    this.routingRuntime = routingRuntime;
    this.guiBus = guiBus;
    this.now = now;
    this.owner = owner;
    this.leaseMs = leaseMs;
    this.onWorkflowChange = onWorkflowChange;
    this.locks = new Map();
    this.timer = null;
  }

  notify(workflow) {
    if (typeof this.onWorkflowChange === 'function') this.onWorkflowChange(workflow);
    return workflow;
  }

  run(workflowId) {
    const id = String(workflowId || '');
    const previous = this.locks.get(id) || Promise.resolve();
    const current = previous.catch(() => {}).then(() => this.runOnce(id));
    this.locks.set(id, current);
    const cleanup = () => { if (this.locks.get(id) === current) this.locks.delete(id); };
    current.then(cleanup, cleanup);
    return current;
  }

  async runOnce(id) {
    let workflow = this.store.get(id);
    if (!workflow) return null;
    if (workflow.autopilotMode !== 'auto') return workflow;
    if (workflow.autoState === 'DONE' || workflow.autoState === 'STOPPED') return workflow;
    if (workflow.autoState === 'PAUSED' || workflow.autoState === 'BLOCKED') return workflow;
    if (workflow.controlOwner === 'human') return workflow;

    if (workflow.autoState === 'OFF') workflow = this.store.transitionState(id, 'PREFLIGHT', 'auto_preflight');
    if (workflow.autoState === 'PREFLIGHT') workflow = this.store.transitionState(id, 'WAITING_AGENT', 'waiting_agent');
    if (workflow.autoState === 'WAITING_AGENT') workflow = this.store.transitionState(id, 'REVIEWING', 'auto_review');
    if (workflow.controlOwner !== this.owner) workflow = this.store.claim(id, this.owner, this.leaseMs, this.now());

    const dependencies = typeof this.resolveDependencies === 'function' ? this.resolveDependencies(workflow.agent, workflow) : null;
    const session = await this.preflightSession(workflow, dependencies);
    const progress = calculateProgress({ workflow, now: this.now() });
    workflow = this.store.updateFields(id, { progress }, 'progress_updated');
    let decision = buildSupervisorDecision({ workflow, progress });
    const safeDecision = sanitizeSupervisorDecision(decision);
    workflow = this.store.updateFields(id, {
      lastDecision: safeDecision,
      lastTurnContract: safeDecision.turnContract,
    }, 'supervisor_decision');

    if (decision.decision === 'DONE') return this.finish(workflow, 'DONE', 'DoD Complete', safeDecision);
    if (decision.decision === 'NEED_HUMAN') return this.finish(workflow, 'PAUSED', progress.stopReason || 'Need Human', safeDecision);

    const watchdog = checkWatchdog({ workflow, instruction: decision.instruction, now: this.now() });
    const capabilities = this.capabilities(dependencies);
    const gate = evaluatePolicyGate({ workflow, capabilities, session, instruction: decision.instruction, watchdog, allowedRoots: this.allowedRoots });
    if (!gate.allowed) {
      const state = gateState(gate.reasonCode);
      return this.finish(workflow, state, stopReason(gate.reasonCode, gate.reason), safeDecision, gate.reason);
    }

    const routingOutcome = await this.prepareRouting({ workflow, progress, decision, safeDecision, dependencies });
    if (routingOutcome) {
      workflow = this.recordRoutingOutcome(workflow, routingOutcome);
      const routeDecision = routingOutcome.decision || {};
      if (routeDecision.action === 'pause') {
        return this.finish(workflow, 'PAUSED', stopReason(routeDecision.reasonCode, 'Routing Paused'), safeDecision, routingOutcome.error || 'Routing paused');
      }
      if (routeDecision.action === 'apply' && (!routingOutcome.profileResult || routingOutcome.profileResult.ok !== true)) {
        const failure = routingOutcome.profileResult || {};
        workflow = this.store.updateFields(workflow.id, {
          lastError: failure.error || failure.code || 'Profile Apply unverified',
          stopReason: 'Profile Apply Unverified',
        }, 'routing_failed');
        return this.finish(workflow, 'PAUSED', 'Profile Apply Unverified', safeDecision, workflow.lastError);
      }
    }

    workflow = this.store.incrementRun(id);
    workflow = this.store.transitionState(id, 'DISPATCHING', 'auto_dispatching');
    const operationId = 'op-' + crypto.randomUUID();
    this.store.appendWal(id, {
      operationId, state: 'pending', phase: 'DISPATCHING', sendAttempted: false,
      instructionFingerprint: watchdog.fingerprint, instruction: decision.instruction,
    });
    let result;
    try {
      result = await this.guiBus.run({ agent: workflow.agent, sessionRef: workflow.binding.sessionRef }, () => this.dispatch({
        agent: workflow.agent,
        project: workflow.binding.projectPath,
        sessionRef: workflow.binding.sessionRef,
        message: decision.instruction,
      }, dependencies));
    } catch (error) {
      result = { ok: false, status: 'failed', phase: 'DISPATCH', failure: { code: 'DISPATCH_FAILED', reason: error.message }, reconciliationRequired: false };
    }

    const sendAttempted = result && (result.reconciliationRequired === true
      || (Array.isArray(result.phases) && result.phases.some((phase) => phase.phase === 'SEND')));
    const walState = result && result.ok ? 'committed' : 'reconcile_required';
    this.store.appendWal(id, {
      operationId, state: walState, phase: result && result.phase || 'DISPATCH', sendAttempted,
      instructionFingerprint: watchdog.fingerprint, instruction: decision.instruction,
      reason: result && result.failure && result.failure.reason || '',
    });
    this.store.appendDispatchRecord(id, {
      attempt: workflow.runCount, state: result && result.ok ? 'committed' : 'failed',
      instructionFingerprint: watchdog.fingerprint, turnContract: safeDecision.turnContract,
      phase: result && result.phase || 'DISPATCH', failureReasonCode: result && result.failure && result.failure.code,
      routing: workflow.lastRouting,
      sessionRef: workflow.binding.sessionRef,
    });
    if (!result || result.ok !== true || result.status !== 'committed') {
      const reason = sendAttempted ? 'Delivery Unverified' : 'Blocked';
      workflow = this.store.updateFields(id, {
        lastError: result && result.failure && result.failure.reason || 'Verified Dispatch failed',
        lastInstructionFingerprint: watchdog.fingerprint,
        dispatchFailures: Number(workflow.dispatchFailures || 0) + 1,
        consecutiveFailures: Number(workflow.consecutiveFailures || 0) + 1,
        stopReason: reason,
      }, 'dispatch_failed');
      return this.finish(workflow, 'PAUSED', reason, safeDecision);
    }

    workflow = this.store.updateFields(id, {
      lastError: '', lastInstructionFingerprint: watchdog.fingerprint,
      consecutiveFailures: 0, dispatchFailures: 0, stopReason: null,
    }, 'dispatch_committed');
    workflow = this.store.transitionState(id, 'VERIFYING', 'delivery_verified');
    workflow = this.store.transitionState(id, 'WAITING_AGENT', 'waiting_agent');
    return this.notify(this.store.get(id) || workflow);
  }

  capabilities(dependencies) {
    const hasWriter = dependencies && dependencies.writer
      && typeof dependencies.writer.write === 'function' && typeof dependencies.writer.send === 'function';
    return {
      sessionIdentity: true,
      completionDetector: Boolean(dependencies && dependencies.completionDetector),
      messageWriter: Boolean(hasWriter),
      deliveryVerifier: Boolean(dependencies && typeof dependencies.verifyDelivery === 'function'),
      verifiedDispatch: typeof this.dispatch === 'function',
    };
  }

  async prepareRouting(context) {
    if (!this.routingRuntime || typeof this.routingRuntime.prepare !== 'function') return null;
    try {
      return await this.routingRuntime.prepare(context);
    } catch (error) {
      return {
        decision: { enabled: true, action: 'continue', reasonCode: 'ROUTING_RUNTIME_FAILED', routeRequest: null, resolvedProfile: null },
        profileResult: null,
        error: error instanceof Error ? error.message : String(error || 'routing runtime failed'),
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
    return this.store.recordRouting(workflow.id, { summary, auditEvent: outcome.auditEvent });
  }

  async preflightSession(workflow, dependencies) {
    if (!dependencies || typeof dependencies.resolveSession !== 'function' || typeof dependencies.verifySession !== 'function') return null;
    const binding = workflow.binding || {};
    if (!binding.sessionRef) return null;
    try {
      const request = { agent: workflow.agent, project: binding.projectPath, sessionRef: binding.sessionRef, message: '' };
      const resolution = await dependencies.resolveSession(request, { phase: 'PREFLIGHT' });
      const target = enrichVerifiedTarget(request, resolution);
      if (!target) return null;
      const verification = await dependencies.verifySession(target, { request, resolution, phase: 'PREFLIGHT' });
      if (!verification || verification.strongAnchor !== true) return null;
      return { ...target, ...verification };
    } catch { return null; }
  }

  async reconcile(id) {
    let workflow = this.store.get(id);
    if (!workflow) return null;
    const dependencies = typeof this.resolveDependencies === 'function' ? this.resolveDependencies(workflow.agent, workflow) : null;
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
        return dependencies.verifyDelivery(target, entry.instruction || '', { phase: 'RECOVERY', verification });
      },
    });
    workflow = this.store.get(id) || result;
    const progress = calculateProgress({ workflow, now: this.now() });
    workflow = this.store.updateFields(id, { progress }, 'reconciled');
    if (progress.status === 'completed' && workflow.autoState !== 'DONE') {
      return this.finish(workflow, 'DONE', 'DoD Complete', workflow.lastDecision);
    }
    return this.notify(this.store.get(id) || workflow);
  }

  async reconcileAll() {
    const workflows = this.store.list().filter((workflow) => workflow.autopilotMode === 'auto');
    for (const workflow of workflows) await this.reconcile(workflow.id);
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
      ...(state === 'DONE' || state === 'BLOCKED' || state === 'PAUSED' ? { endedAt: this.now() } : {}),
    };
    current = this.store.updateFields(current.id, fields, 'auto_stopped');
    if (current.autoState !== state) current = this.store.transitionState(current.id, state, 'auto_stopped');
    const progress = calculateProgress({ workflow: current, now: this.now() });
    current = this.store.updateFields(current.id, { progress }, 'progress_updated');
    const receipt = buildRunReceipt({ workflow: current, finalState: state, stopReason: reason, now: this.now(), decision });
    current = this.store.updateFields(current.id, { runReceipt: receipt }, 'run_receipt_created');
    if (current.controlOwner === this.owner) current = this.store.release(current.id, this.owner);
    return this.notify(this.store.get(current.id) || current);
  }

  startPeriodicReconciliation(intervalMs = 60_000) {
    if (this.timer) return this.stopPeriodicReconciliation.bind(this);
    this.timer = setInterval(() => { this.reconcileAll().catch(() => {}); }, intervalMs);
    this.timer.unref?.();
    return this.stopPeriodicReconciliation.bind(this);
  }

  stopPeriodicReconciliation() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

module.exports = { AutoLoop, gateState, stopReason };
