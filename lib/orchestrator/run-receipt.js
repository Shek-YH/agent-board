'use strict';

const { normalizeAuditEventName } = require('./routing/audit');

function safeCount(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function safeText(value, max = 2_000) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, max)
    .replace(/((?:api[_-]?key|token|secret|password)\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]');
}

function safeAcceptedTurn(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
  const routeRequest = snapshot.routeRequest && typeof snapshot.routeRequest === 'object' ? snapshot.routeRequest : {};
  const resolvedProfile = snapshot.resolvedProfile && typeof snapshot.resolvedProfile === 'object' ? snapshot.resolvedProfile : {};
  const verification = snapshot.verification && typeof snapshot.verification === 'object' ? snapshot.verification : {};
  const safe = {
    turnId: safeText(snapshot.turnId, 100),
    attempt: safeCount(snapshot.attempt),
    routeRequest: {
      complexityTier: safeText(routeRequest.complexityTier, 10),
      thinkingTier: safeText(routeRequest.thinkingTier, 10),
      promptPolicy: safeText(routeRequest.promptPolicy, 10),
    },
    resolvedProfile: {
      modelId: safeText(resolvedProfile.modelId, 200),
      reasoningLevel: safeText(resolvedProfile.reasoningLevel, 30).toLowerCase(),
    },
    verification: {
      verified: verification.verified === true,
      ...(safeText(verification.source, 40) ? { source: safeText(verification.source, 40) } : {}),
      ...(safeText(verification.resultCode, 80) ? { resultCode: safeText(verification.resultCode, 80) } : {}),
    },
  };
  return safe.turnId && safe.resolvedProfile.modelId ? safe : null;
}

function safeRoutingSummary(routing) {
  if (!routing || typeof routing !== 'object') return null;
  return {
    enabled: routing.enabled === true,
    action: safeText(routing.action, 30),
    reasonCode: safeText(routing.reasonCode, 80),
    complexityTier: safeText(routing.complexityTier, 10),
    thinkingTier: safeText(routing.thinkingTier, 10),
    promptPolicy: safeText(routing.promptPolicy, 10),
    modelId: safeText(routing.modelId, 200),
    reasoningLevel: safeText(routing.reasoningLevel, 30).toLowerCase(),
    source: safeText(routing.source, 40),
    verified: routing.verified === true,
    fallbackApplied: routing.fallbackApplied === true,
    catalogSource: safeText(routing.catalogSource, 40),
    catalogStale: routing.catalogStale === true,
  };
}

function routingFromAcceptedTurn(snapshot, fallback) {
  if (!snapshot) return safeRoutingSummary(fallback);
  const routeRequest = snapshot.routeRequest || {};
  const profile = snapshot.resolvedProfile || {};
  const verification = snapshot.verification || {};
  return safeRoutingSummary({
    ...(fallback || {}), enabled: true, action: (fallback && fallback.action) || 'apply',
    complexityTier: routeRequest.complexityTier, thinkingTier: routeRequest.thinkingTier,
    promptPolicy: routeRequest.promptPolicy, modelId: profile.modelId,
    reasoningLevel: profile.reasoningLevel, source: verification.source,
    verified: verification.verified === true,
  });
}

function routingAuditSummary(workflow) {
  const events = Array.isArray(workflow.routingAudit)
    ? workflow.routingAudit.map((entry) => normalizeAuditEventName(entry && entry.event)) : [];
  const count = (name) => events.filter((event) => event === name).length;
  return {
    escalations: Math.max(safeCount(workflow.routingEscalations), count('ROUTE_ESCALATED')),
    downgrades: Math.max(safeCount(workflow.routingDowngrades), count('ROUTE_DOWNGRADED')),
    verifiedProfileChanges: count('MODEL_APPLY_VERIFIED') || count('PROFILE_VERIFIED'),
    failures: count('MODEL_APPLY_FAILED') || count('PROFILE_UNVERIFIED') || count('PROFILE_APPLY_FAILED'),
  };
}

function buildRunReceipt({ workflow, finalState, stopReason = null, now = Date.now(), decision = null } = {}) {
  if (!workflow || typeof workflow !== 'object') throw new TypeError('workflow is required');
  const contract = workflow.runContract || {};
  const dod = contract.verify && Array.isArray(contract.verify.dod) ? contract.verify.dod : [];
  const progress = workflow.progress || {};
  const acceptedTurn = safeAcceptedTurn(workflow.acceptedTurnSnapshot || workflow.acceptedTurn);
  const receipt = {
    version: 2,
    runId: safeText(workflow.id, 100),
    agent: safeText(workflow.agent, 40),
    goal: safeText(contract.goal, 20_000),
    iterations: safeCount(workflow.runCount),
    dod: { passed: safeCount(progress.completed), total: dod.length },
    finalState: safeText(finalState || workflow.autoState || 'UNKNOWN', 30),
    stopReason: safeText(stopReason, 200) || null,
    counters: {
      consecutiveFailures: safeCount(workflow.consecutiveFailures),
      stagnation: safeCount(workflow.stagnationCount),
      dispatchFailures: safeCount(workflow.dispatchFailures),
      routingEscalations: safeCount(workflow.routingEscalations),
      routingDowngrades: safeCount(workflow.routingDowngrades),
    },
    supervisor: decision ? {
      decision: String(decision.decision || ''),
      reasonCode: String(decision.reasonCode || ''),
      summary: safeText(decision.summary, 2_000),
    } : null,
    routing: routingFromAcceptedTurn(acceptedTurn, workflow.lastRouting),
    acceptedTurn,
    routingSummary: routingAuditSummary(workflow),
    generatedAt: new Date(Number.isFinite(now) ? now : Date.now()).toISOString(),
  };
  return receipt;
}

module.exports = { buildRunReceipt, safeAcceptedTurn };
