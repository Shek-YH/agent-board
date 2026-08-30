'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildRoutingDiagnostics,
  buildRoutingTimeline,
  buildRoutingUsage,
  buildSafeReceipt,
} = require('./commercial');

function workflow() {
  return {
    id: 'wf-commercial', agent: 'codex',
    routingConfig: {
      enabled: true, preset: 'balanced',
      manualPin: { modelId: 'strong', reasoningLevel: 'high' },
    },
    lastRouting: {
      enabled: true, action: 'apply', reasonCode: 'MANUAL_PIN', complexityTier: 'C1', thinkingTier: 'T1',
      promptPolicy: 'P1', modelId: 'strong', reasoningLevel: 'high', source: 'native', verified: true,
      fallbackApplied: false, catalogSource: 'native', catalogStale: false,
    },
    routingAudit: [{
      schemaVersion: 1, event: 'profile_verified', generatedAt: '2026-08-30T12:00:00.000Z',
      sessionFingerprint: 'session-fingerprint', fingerprint: 'route-fingerprint',
      route: { enabled: true, action: 'apply', reasonCode: 'MANUAL_PIN', complexityTier: 'C1', thinkingTier: 'T1', promptPolicy: 'P1' },
      profile: { modelId: 'strong', reasoningLevel: 'high', source: 'native', verified: true, fallbackApplied: false },
      catalog: { source: 'native', stale: false },
      prompt: 'must not escape', token: 'must not escape', instruction: 'must not escape',
    }],
    routingEscalations: 1, routingDowngrades: 0,
    runReceipt: {
      version: 1, runId: 'wf-commercial', agent: 'codex', goal: '完成目标', iterations: 2,
      dod: { passed: 1, total: 2 }, finalState: 'PAUSED', stopReason: 'Need Human',
      counters: { consecutiveFailures: 1, stagnation: 0, dispatchFailures: 0, routingEscalations: 1, routingDowngrades: 0 },
      routing: { modelId: 'strong', reasoningLevel: 'high', verified: true }, generatedAt: '2026-08-30T12:01:00.000Z',
      instruction: 'must not escape', token: 'must not escape',
    },
  };
}

test('builds safe catalog diagnostics and explicit unavailable usage state', () => {
  const diagnostics = buildRoutingDiagnostics({
    workflow: workflow(),
    catalog: {
      source: 'cache', available: true, stale: true, reasonCode: 'NATIVE_CATALOG_UNAVAILABLE',
      agentVersion: '0.151.0', fetchedAt: 1234, models: [{ id: 'strong' }, { id: 'balanced' }],
    },
    supportedAgents: ['codex'],
  });

  assert.deepEqual(diagnostics.compatibility, { supported: true, reasonCode: 'SUPPORTED' });
  assert.deepEqual(diagnostics.catalog, {
    source: 'cache', available: true, stale: true, reasonCode: 'NATIVE_CATALOG_UNAVAILABLE',
    agentVersion: '0.151.0', fetchedAt: 1234, modelCount: 2,
  });
  assert.deepEqual(buildRoutingUsage(workflow()), {
    cost: { available: false, reasonCode: 'COST_DATA_UNAVAILABLE' },
    quota: { available: false, reasonCode: 'QUOTA_DATA_UNAVAILABLE' },
    counters: { routingEscalations: 1, routingDowngrades: 0 },
  });
  assert.equal(JSON.stringify(diagnostics).includes('must not escape'), false);
});

test('builds explainable audit timeline and strips untrusted content', () => {
  const timeline = buildRoutingTimeline(workflow());
  assert.deepEqual(timeline, [{
    generatedAt: '2026-08-30T12:00:00.000Z', event: 'profile_verified', action: 'apply',
    reasonCode: 'MANUAL_PIN', complexityTier: 'C1', thinkingTier: 'T1', promptPolicy: 'P1',
    modelId: 'strong', reasoningLevel: 'high', source: 'native', verified: true,
    fallbackApplied: false, catalogSource: 'native', catalogStale: false, fingerprint: 'route-fingerprint',
  }]);
});

test('builds a safe receipt view without instruction or token fields', () => {
  const receipt = buildSafeReceipt(workflow());
  assert.equal(receipt.runId, 'wf-commercial');
  assert.equal(receipt.routing.modelId, 'strong');
  assert.equal('instruction' in receipt, false);
  assert.equal('token' in receipt, false);
  assert.equal(JSON.stringify(receipt).includes('must not escape'), false);
});

test('exposes configured supervisor budget as quota without inventing provider cost', () => {
  const current = workflow();
  current.runContract = { ...current.runContract, budget: { supervisorCostLimit: 10 } };
  current.supervisorCostUsed = 3;

  assert.deepEqual(buildRoutingUsage(current), {
    cost: { available: false, reasonCode: 'COST_DATA_UNAVAILABLE' },
    quota: { available: true, source: 'run_contract', unit: 'supervisor_cost', used: 3, limit: 10, remaining: 7 },
    counters: { routingEscalations: 1, routingDowngrades: 0 },
  });
});
