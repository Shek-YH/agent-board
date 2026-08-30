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
const { buildRoutingAuditEvent } = require('./routing/audit');

function errorFingerprint(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex').slice(0, 64);
}

function gateState(reasonCode) {
  return ['NEED_HUMAN', 'PERMISSION_REQUIRED', 'IDENTITY_UNVERIFIED', 'DELIVERY_UNVERIFIED', 'PROFILE_UNVERIFIED'].includes(reasonCode)
    ? 'PAUSED' : 'BLOCKED';
}

function stopReason(reasonCode, reason) {
  if (String(reasonCode || '').startsWith('NEED_HUMAN') || reasonCode === 'PERMISSION_REQUIRED') return 'Need Human';
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
    profileReader = null,
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
    this.profileReader = profileReader;
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

    const recoveredProfile = workflow.profileApplyReconciled === true && workflow.acceptedTurnSnapshot;
    if (recoveredProfile) {
      workflow = this.store.updateFields(id, { profileApplyReconciled: false }, 'profile_reconciliation_resumed');
    } else {
      if (workflow.acceptedTurnSnapshot && typeof this.store.clearAcceptedTurn === 'function') {
        workflow = this.store.clearAcceptedTurn(id);
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
    }

    workflow = this.store.incrementRun(id);
    workflow = this.store.transitionState(id, 'DISPATCHING', 'auto_dispatching');
    const operationId = 'op-' + crypto.randomUUID();
    this.store.appendWal(id, {
      operationId, kind: 'dispatch', attempt: workflow.runCount, state: 'pending', phase: 'DISPATCHING', sendAttempted: false,
      instructionFingerprint: watchdog.fingerprint,
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
      operationId, kind: 'dispatch', attempt: workflow.runCount, state: walState, phase: result && result.phase || 'DISPATCH', sendAttempted,
      instructionFingerprint: watchdog.fingerprint,
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

  async reconcile(id) {
    let workflow = this.store.get(id);
    if (!workflow) return null;
    const dependencies = typeof this.resolveDependencies === 'function' ? this.resolveDependencies(workflow.agent, workflow) : null;
    workflow = await this.reconcileProfileApply(workflow, dependencies);
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
