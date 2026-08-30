'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRoutingRuntime, normalizeRoutingConfig } = require('./runtime');

function workflow(overrides = {}) {
  return {
    agent: 'codex',
    binding: { sessionRef: 'codex:11111111-1111-4111-8111-111111111111' },
    routingConfig: { enabled: true, preset: 'balanced', modelOrder: ['strong'], ...overrides },
    consecutiveFailures: 0, stagnationCount: 0, runCount: 0,
  };
}

function nativeCapability(calls) {
  return {
    listModels: async () => {
      calls.push('list');
      return {
        data: [{ id: 'strong', model: 'strong', displayName: 'Strong', hidden: false,
          supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }, { reasoningEffort: 'high' }] }],
      };
    },
    applyProfile: async ({ profile }) => {
      calls.push('apply');
      return { source: 'native', verified: true, readback: { modelId: profile.modelId, reasoningLevel: profile.reasoningLevel } };
    },
  };
}

test('returns no routing work when the workflow setting is disabled', async () => {
  const runtime = createRoutingRuntime({ nativeCapability: nativeCapability([]) });
  assert.equal(await runtime.prepare({ workflow: workflow({ enabled: false }) }), null);
});

test('resolves, applies, verifies, and audits one Codex route', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-routing-runtime-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  const runtime = createRoutingRuntime({
    nativeCapability: nativeCapability(calls), cachePath: path.join(dir, 'cache.json'), now: () => 2_000,
  });

  const result = await runtime.prepare({ workflow: workflow(), progress: { regression: false } });

  assert.deepEqual(calls, ['list', 'apply']);
  assert.equal(result.decision.action, 'apply');
  assert.equal(result.profileResult.ok, true);
  assert.equal(result.profileResult.verified, true);
  assert.equal(result.auditEvent.event, 'profile_verified');
  assert.equal(result.auditEvent.profile.modelId, 'strong');
});

test('keeps base AutoPilot available when native catalog is unavailable', async () => {
  const runtime = createRoutingRuntime({
    nativeCapability: null,
    cachePath: path.join(os.tmpdir(), 'agent-board-routing-missing-cache.json'),
  });
  const result = await runtime.prepare({ workflow: workflow() });
  assert.equal(result.profileResult, null);
  assert.equal(result.decision.action, 'continue');
  assert.equal(result.decision.reasonCode, 'ROUTING_UNAVAILABLE');
});

test('does not route unsupported agents', async () => {
  const runtime = createRoutingRuntime({ nativeCapability: nativeCapability([]) });
  const result = await runtime.prepare({ workflow: { ...workflow(), agent: 'claude' } });
  assert.equal(result.decision.action, 'continue');
  assert.equal(result.decision.reasonCode, 'ROUTING_AGENT_UNSUPPORTED');
  assert.equal(result.profileResult, null);
});

test('uses an injected second-agent adapter without adding agent-specific logic to the router', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-routing-second-agent-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  const adapter = {
    listModels: async () => ({ data: [{ id: 'hermes-strong', model: 'hermes-strong', displayName: 'Hermes Strong', hidden: false, supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }] }),
    applyProfile: async ({ profile }) => { calls.push(profile.modelId); return { source: 'hermes-native', readback: profile, verified: true }; },
  };
  const runtime = createRoutingRuntime({
    agentCapabilities: { hermes: adapter }, cachePath: path.join(dir, 'cache.json'),
  });

  const result = await runtime.prepare({ workflow: { ...workflow(), agent: 'hermes', routingConfig: { enabled: true, preset: 'balanced' } } });

  assert.equal(result.decision.action, 'apply');
  assert.equal(result.profileResult.ok, true);
  assert.deepEqual(calls, ['hermes-strong']);
});

test('normalizes only safe routing configuration fields', () => {
  assert.deepEqual(normalizeRoutingConfig({
    enabled: true, preset: 'quality', modelOrder: ['strong', 1], manualPin: { modelId: 'strong', reasoningLevel: 'HIGH' },
    prompt: 'should not survive', token: 'should not survive',
  }), {
    enabled: true, preset: 'quality', complexityTier: 'C3', thinkingTier: 'T3', promptPolicy: 'P2',
    modelOrder: ['strong'], manualPin: { modelId: 'strong', reasoningLevel: 'high' }, allowFallback: false, showDetails: true,
  });
});
