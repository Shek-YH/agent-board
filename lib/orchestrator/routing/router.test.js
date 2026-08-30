'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveRoutingDecision } = require('./router');

function catalog() {
  return {
    source: 'native', stale: false, available: true,
    models: [
      { id: 'strong', supportedReasoningLevels: ['low', 'medium', 'high', 'max'], visibility: 'list' },
      { id: 'balanced', supportedReasoningLevels: ['low', 'medium', 'high'], visibility: 'list' },
      { id: 'fast', supportedReasoningLevels: ['low', 'medium'], visibility: 'list' },
    ],
  };
}

test('keeps Slice 3 behavior when smart routing is disabled', () => {
  const decision = resolveRoutingDecision({
    enabled: false, catalog: catalog(), modelOrder: ['strong', 'balanced', 'fast'],
    complexityTier: 'C1', thinkingTier: 'T1', promptPolicy: 'P1',
  });

  assert.equal(decision.enabled, false);
  assert.equal(decision.action, 'continue');
  assert.equal(decision.reasonCode, 'ROUTING_DISABLED');
  assert.equal(decision.resolvedProfile, null);
});

test('escalates complexity and thinking after a failure signal', () => {
  const decision = resolveRoutingDecision({
    enabled: true, catalog: catalog(), modelOrder: ['strong', 'balanced', 'fast'],
    complexityTier: 'C1', thinkingTier: 'T1', promptPolicy: 'P2', consecutiveFailures: 1,
  });

  assert.equal(decision.action, 'apply');
  assert.equal(decision.routeRequest.complexityTier, 'C2');
  assert.equal(decision.routeRequest.thinkingTier, 'T2');
  assert.equal(decision.resolvedProfile.modelId, 'strong');
  assert.equal(decision.reasonCode, 'ROUTE_ESCALATED');
});

test('allows one bounded downgrade only after success and task simplification', () => {
  const decision = resolveRoutingDecision({
    enabled: true, catalog: catalog(), modelOrder: ['strong', 'balanced', 'fast'],
    complexityTier: 'C2', thinkingTier: 'T2', promptPolicy: 'P0',
    lastRunSucceeded: true, taskSimplified: true,
  });

  assert.equal(decision.routeRequest.complexityTier, 'C1');
  assert.equal(decision.routeRequest.thinkingTier, 'T1');
  assert.equal(decision.reasonCode, 'ROUTE_DOWNGRADED');
  assert.equal(decision.resolvedProfile.modelId, 'balanced');
});

test('manual pins win over automatic model selection', () => {
  const decision = resolveRoutingDecision({
    enabled: true, catalog: catalog(), modelOrder: ['strong', 'balanced', 'fast'],
    complexityTier: 'C0', thinkingTier: 'T0', manualPin: { modelId: 'balanced', reasoningLevel: 'high' },
    consecutiveFailures: 3,
  });

  assert.equal(decision.action, 'apply');
  assert.equal(decision.resolvedProfile.modelId, 'balanced');
  assert.equal(decision.resolvedProfile.reasoningLevel, 'high');
  assert.equal(decision.resolvedProfile.manualPin, true);
  assert.equal(decision.reasonCode, 'MANUAL_PIN');
});

test('keeps base AutoPilot available when the catalog is unavailable', () => {
  const decision = resolveRoutingDecision({
    enabled: true, catalog: { source: 'unavailable', available: false, models: [] },
    modelOrder: ['strong'], complexityTier: 'C1', thinkingTier: 'T1',
  });

  assert.equal(decision.action, 'continue');
  assert.equal(decision.reasonCode, 'ROUTING_UNAVAILABLE');
  assert.equal(decision.resolvedProfile, null);
});

test('pauses instead of overriding an unavailable manual pin', () => {
  const decision = resolveRoutingDecision({
    enabled: true, catalog: catalog(), modelOrder: ['strong'],
    manualPin: { modelId: 'missing', reasoningLevel: 'high' },
  });

  assert.equal(decision.action, 'pause');
  assert.equal(decision.reasonCode, 'MANUAL_PIN_UNAVAILABLE');
});

test('escalates to human instead of retrying after a failure at the highest tier', () => {
  const decision = resolveRoutingDecision({
    enabled: true, catalog: catalog(), modelOrder: ['strong', 'balanced', 'fast'],
    complexityTier: 'C1', thinkingTier: 'T1', consecutiveFailures: 1,
    lastRouting: { complexityTier: 'C3', thinkingTier: 'T3', modelId: 'strong' },
  });

  assert.equal(decision.action, 'pause');
  assert.equal(decision.reasonCode, 'NEED_HUMAN_HIGHEST_TIER_FAILURE');
  assert.equal(decision.resolvedProfile, null);
});
