'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRoutingRuntime, normalizeRoutingConfig, cachePathForAgent } = require('./runtime');

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
  assert.equal(result.auditEvent.event, 'PROFILE_VERIFIED');
  assert.equal(result.auditEvent.profile.modelId, 'strong');
});

test('reports model catalog probe metadata without coupling it to routing decisions', async () => {
  const probes = [];
  const runtime = createRoutingRuntime({
    nativeCapability: nativeCapability([]),
    onCatalogProbe: (agent, catalog) => probes.push({ agent, source: catalog.source, fetchedAt: catalog.fetchedAt }),
    now: () => 2_000,
  });

  const catalog = await runtime.getCatalog({ agent: 'codex' });
  assert.equal(catalog.source, 'native');
  assert.deepEqual(probes, [{ agent: 'codex', source: 'native', fetchedAt: 2_000 }]);
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

test('exposes all registered capability agents for transparent capability reporting', () => {
  const runtime = createRoutingRuntime({
    nativeCapability: null,
    agentCapabilities: { hermes: { supportsReasoning: false, routingMode: 'prompt-only' } },
  });

  assert.deepEqual(runtime.capabilityAgents(), ['codex', 'hermes']);
});

test('keeps base AutoPilot running when a second agent is prompt-only', async () => {
  const calls = [];
  const adapter = {
    supportsReasoning: false,
    listModels: async () => ({ data: [{ id: 'hermes-current', model: 'hermes-current', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }] }),
    detectManualPin: async () => { calls.push('detect'); return { modelId: 'hermes-current', reasoningLevel: 'high', changedBy: 'human' }; },
  };
  const runtime = createRoutingRuntime({ agentCapabilities: { hermes: adapter } });

  const result = await runtime.prepare({ workflow: { ...workflow(), agent: 'hermes' } });

  assert.equal(result.decision.action, 'continue');
  assert.equal(result.decision.reasonCode, 'ROUTING_AGENT_UNSUPPORTED');
  assert.equal(result.profileResult, null);
  assert.deepEqual(calls, []);
});

test('fails closed when profile testing targets a prompt-only agent', async () => {
  const runtime = createRoutingRuntime({
    agentCapabilities: {
      hermes: {
        supportsReasoning: false,
        listModels: async () => ({ data: [{ id: 'hermes-current', model: 'hermes-current' }] }),
      },
    },
  });

  const result = await runtime.testProfile({
    workflow: { ...workflow(), agent: 'hermes' }, modelId: 'hermes-current', reasoningLevel: 'high',
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'ROUTING_AGENT_UNSUPPORTED');
  assert.equal(result.dispatchAllowed, false);
});

test('normalizes only safe routing configuration fields', () => {
  assert.deepEqual(normalizeRoutingConfig({
    enabled: true, preset: 'quality', modelOrder: ['strong', 1], manualPin: { modelId: 'strong', reasoningLevel: 'HIGH' },
    prompt: 'should not survive', token: 'should not survive',
  }), {
    enabled: true, preset: 'quality', complexityTier: 'C3', thinkingTier: 'T3', promptPolicy: 'P2',
    modelOrder: ['strong'], manualPin: { modelId: 'strong', reasoningLevel: 'high' }, allowFallback: false,
    autoModel: true, autoReasoning: true, respectManualPin: true, allowLegacyModels: false, showDetails: true,
  });
});

test('detects an explicit human profile change and preserves it as a manual pin', async () => {
  const calls = [];
  const runtime = createRoutingRuntime({
    nativeCapability: {
      listModels: async () => ({ data: [
        { id: 'sol', model: 'sol', hidden: false, supportedReasoningEfforts: [{ reasoningEffort: 'high' }] },
        { id: 'terra', model: 'terra', hidden: false, supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] },
      ] }),
      readProfile: async () => ({ modelId: 'sol', reasoningLevel: 'high', changedBy: 'human' }),
      applyProfile: async () => { calls.push('apply'); return { readback: { modelId: 'sol', reasoningLevel: 'high' } }; },
    },
  });

  const result = await runtime.prepare({ workflow: {
    ...workflow(),
    lastRouting: { modelId: 'terra', reasoningLevel: 'medium' },
    routingConfig: { enabled: true, preset: 'balanced', modelOrder: ['terra', 'sol'] },
  } });

  assert.equal(result.decision.resolvedProfile.modelId, 'sol');
  assert.equal(result.decision.resolvedProfile.manualPin, true);
  assert.equal(result.decision.reasonCode, 'MANUAL_PIN');
  assert.deepEqual(calls, ['apply']);
});

test('keeps per-agent catalog caches isolated when adapters share a base path', () => {
  assert.equal(cachePathForAgent('C:\\tmp\\routing.json', 'codex'), 'C:\\tmp\\routing.json');
  assert.equal(cachePathForAgent('C:\\tmp\\routing.json', 'hermes'), 'C:\\tmp\\routing-hermes.json');
});

test('isolates non-Codex adapters when the caller uses the default cache path', () => {
  const codexPath = cachePathForAgent(undefined, 'codex');
  const hermesPath = cachePathForAgent(undefined, 'hermes');
  assert.ok(codexPath);
  assert.notEqual(hermesPath, codexPath);
  assert.match(hermesPath, /-hermes\.json$/);
});

test('reports generic capability status and verifies an explicit profile test without dispatch', async () => {
  const runtime = createRoutingRuntime({
    nativeCapability: {
      listModels: async () => ({ models: [{ id: 'strong', supportedReasoningLevels: ['high'] }] }),
      applyProfile: async ({ profile }) => ({ readback: profile, source: 'native' }),
    },
  });
  const workflowValue = { ...workflow(), routingConfig: { enabled: true, preset: 'balanced' } };
  assert.deepEqual(runtime.getCapabilityStatus({ agent: 'codex' }), {
    modelDiscovery: true, modelSwitch: true, reasoningControl: true, profileVerification: true,
  });
  const result = await runtime.testProfile({ workflow: workflowValue, modelId: 'strong', reasoningLevel: 'high' });
  assert.equal(result.ok, true);
  assert.equal(result.code, 'PROFILE_TEST_VERIFIED');
  assert.equal(result.dispatchAllowed, false);
  assert.equal(result.auditEvent.event, 'MODEL_APPLY_VERIFIED');
});

test('refreshes the catalog once and resolves again when a configured model drifts away', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-routing-drift-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let reads = 0;
  const runtime = createRoutingRuntime({
    cachePath: path.join(dir, 'cache.json'),
    nativeCapability: {
      listModels: async () => {
        reads += 1;
        return { models: [{ id: reads === 1 ? 'old-model' : 'strong', supportedReasoningLevels: ['high'] }] };
      },
      applyProfile: async ({ profile }) => ({ readback: profile, verified: true }),
    },
  });
  const result = await runtime.prepare({
    workflow: workflow({ modelOrder: ['strong'] }), progress: { regression: false },
  });

  assert.equal(reads, 2);
  assert.equal(result.decision.resolvedProfile.modelId, 'strong');
  assert.deepEqual(result.auditEvents.map((event) => event.event), ['MODEL_CATALOG_REFRESHED']);
});
