'use strict';

function safeCount(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function buildRunReceipt({ workflow, finalState, stopReason = null, now = Date.now(), decision = null } = {}) {
  if (!workflow || typeof workflow !== 'object') throw new TypeError('workflow is required');
  const contract = workflow.runContract || {};
  const dod = contract.verify && Array.isArray(contract.verify.dod) ? contract.verify.dod : [];
  const progress = workflow.progress || {};
  const receipt = {
    version: 1,
    runId: String(workflow.id || ''),
    agent: String(workflow.agent || ''),
    goal: String(contract.goal || ''),
    iterations: safeCount(workflow.runCount),
    dod: { passed: safeCount(progress.completed), total: dod.length },
    finalState: String(finalState || workflow.autoState || 'UNKNOWN'),
    stopReason: stopReason || null,
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
      summary: String(decision.summary || '').slice(0, 2_000),
    } : null,
    routing: workflow.lastRouting ? {
      enabled: workflow.lastRouting.enabled === true,
      action: String(workflow.lastRouting.action || ''),
      reasonCode: String(workflow.lastRouting.reasonCode || ''),
      complexityTier: String(workflow.lastRouting.complexityTier || ''),
      thinkingTier: String(workflow.lastRouting.thinkingTier || ''),
      promptPolicy: String(workflow.lastRouting.promptPolicy || ''),
      modelId: String(workflow.lastRouting.modelId || ''),
      reasoningLevel: String(workflow.lastRouting.reasoningLevel || ''),
      source: String(workflow.lastRouting.source || ''),
      verified: workflow.lastRouting.verified === true,
      fallbackApplied: workflow.lastRouting.fallbackApplied === true,
      catalogSource: String(workflow.lastRouting.catalogSource || ''),
      catalogStale: workflow.lastRouting.catalogStale === true,
    } : null,
    generatedAt: new Date(Number.isFinite(now) ? now : Date.now()).toISOString(),
  };
  return receipt;
}

module.exports = { buildRunReceipt };
