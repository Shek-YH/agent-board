'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { handleOrchestrationRequest } = require('./http');
const { createOrchestrationRuntime } = require('./runtime');
const { createRoutingRuntime } = require('./routing/runtime');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-http-'));
  const runtime = createOrchestrationRuntime({
    env: { AGENT_BOARD_ALLOWED_ROOTS: dir, AGENT_BOARD_HEADLESS_EXECUTION: '0' },
    filePath: path.join(dir, 'workflows.json'),
    routingCachePath: path.join(dir, 'routing-cache.json'),
  });
  return { dir, runtime };
}

test('HTTP orchestration API creates and lists a workflow without exposing secrets', async () => {
  const { dir, runtime } = setup();
  const created = await handleOrchestrationRequest({
    method: 'POST', pathname: '/api/orchestration/workflows', runtime,
    body: {
      projectPath: path.join(dir, 'app'), goal: '初始化服务', mode: 'project', agent: 'codex',
      verify: { dod: ['测试通过'] },
    },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.classification.kind, 'new');
  const listed = await handleOrchestrationRequest({ method: 'GET', pathname: '/api/orchestration/workflows', runtime });
  assert.equal(listed.body.items.length, 1);
});

test('HTTP takeover endpoint changes the same workflow the AI monitor sees', async () => {
  const { dir, runtime } = setup();
  const created = await handleOrchestrationRequest({
    method: 'POST', pathname: '/api/orchestration/workflows', runtime,
    body: { projectPath: path.join(dir, 'app'), goal: 'x', verify: { dod: ['完成'] } },
  });
  const id = created.body.workflow.id;
  await handleOrchestrationRequest({ method: 'POST', pathname: `/api/orchestration/workflows/${id}/transition`, runtime, body: { status: 'queued' } });
  const takeover = await handleOrchestrationRequest({ method: 'POST', pathname: `/api/orchestration/workflows/${id}/takeover`, runtime, body: {} });
  assert.equal(takeover.body.workflow.controlOwner, 'human');
  assert.equal(takeover.body.workflow.status, 'paused');
  const state = await handleOrchestrationRequest({ method: 'GET', pathname: '/api/orchestration/state', runtime });
  assert.equal(state.body.workflows[0].status, 'paused');
  assert.equal(JSON.stringify(state.body).includes('API_KEY'), false);
});

test('run endpoint accepts work and keeps disabled headless execution waiting for policy', async () => {
  const { dir, runtime } = setup();
  const created = await handleOrchestrationRequest({
    method: 'POST', pathname: '/api/orchestration/workflows', runtime,
    body: { projectPath: path.join(dir, 'app'), goal: 'x', agent: 'codex', verify: { dod: ['完成'] } },
  });
  const id = created.body.workflow.id;
  const accepted = await handleOrchestrationRequest({ method: 'POST', pathname: `/api/orchestration/workflows/${id}/run`, runtime, body: {} });
  assert.equal(accepted.status, 409);
  assert.equal(accepted.body.code, 'SUGGEST_ONLY');
  assert.equal('background' in accepted, false);
});

test('suggest endpoint returns a structured suggestion without running transport', async () => {
  const { dir, runtime } = setup();
  let ran = false;
  runtime.runner = { run: async () => { ran = true; } };
  const created = await handleOrchestrationRequest({
    method: 'POST', pathname: '/api/orchestration/workflows', runtime,
    body: {
      projectPath: path.join(dir, 'app'), goal: '完成目标', agent: 'codex',
      verify: { dod: ['检查完成'] },
    },
  });
  const id = created.body.workflow.id;
  const suggestion = await handleOrchestrationRequest({
    method: 'POST', pathname: `/api/orchestration/workflows/${id}/suggest`, runtime, body: {},
  });
  assert.equal(suggestion.status, 200);
  assert.equal(suggestion.body.suggestion.action, 'suggest');
  assert.equal(suggestion.body.suggestion.turnContract.send, false);
  assert.equal(runtime.store.get(id).lastReceipt.suggestionId, suggestion.body.suggestion.suggestionId);
  assert.equal(ran, false);
});

test('suggest endpoint reports human takeover without changing ownership', async () => {
  const { dir, runtime } = setup();
  const created = await handleOrchestrationRequest({
    method: 'POST', pathname: '/api/orchestration/workflows', runtime,
    body: { projectPath: path.join(dir, 'app'), goal: 'x', verify: { dod: ['完成'] } },
  });
  const id = created.body.workflow.id;
  await handleOrchestrationRequest({ method: 'POST', pathname: `/api/orchestration/workflows/${id}/takeover`, runtime, body: {} });
  const suggestion = await handleOrchestrationRequest({
    method: 'POST', pathname: `/api/orchestration/workflows/${id}/suggest`, runtime, body: {},
  });
  assert.equal(suggestion.body.suggestion.action, 'need_human');
  assert.equal(runtime.store.get(id).controlOwner, 'human');
});

test('auto run endpoint starts only a bound verified single-session loop', async () => {
  const { dir, runtime } = setup();
  const calls = [];
  runtime.auto = {
    run: async (id) => { calls.push(id); return runtime.store.get(id); },
  };
  const created = await handleOrchestrationRequest({
    method: 'POST', pathname: '/api/orchestration/workflows', runtime,
    body: {
      projectPath: path.join(dir, 'app'), goal: '自动完成', agent: 'codex', autopilotMode: 'auto',
      binding: { sessionRef: 'session-1', agent: 'codex', projectPath: path.join(dir, 'app') },
      verify: { dod: ['完成'] },
    },
  });
  const id = created.body.workflow.id;
  const accepted = await handleOrchestrationRequest({ method: 'POST', pathname: `/api/orchestration/workflows/${id}/run`, runtime, body: {} });
  assert.equal(accepted.status, 202);
  assert.equal(accepted.body.accepted, true);
  await accepted.background;
  assert.deepEqual(calls, [id]);
});

test('auto control endpoints expose evidence, reconcile, resume, and user stop', async () => {
  const { dir, runtime } = setup();
  const calls = [];
  runtime.auto = {
    reconcile: async (id) => { calls.push(['reconcile', id]); return runtime.store.get(id); },
    resume: (id) => { calls.push(['resume', id]); return runtime.store.get(id); },
    stop: (id) => { calls.push(['stop', id]); return runtime.store.get(id); },
  };
  const created = await handleOrchestrationRequest({
    method: 'POST', pathname: '/api/orchestration/workflows', runtime,
    body: { projectPath: path.join(dir, 'app'), goal: 'x', agent: 'codex', autopilotMode: 'auto',
      binding: { sessionRef: 'session-1', agent: 'codex', projectPath: path.join(dir, 'app') }, verify: { dod: ['完成'] } },
  });
  const id = created.body.workflow.id;
  const evidence = await handleOrchestrationRequest({ method: 'POST', pathname: `/api/orchestration/workflows/${id}/evidence`, runtime,
    body: { dodIndex: 0, passed: true, summary: '完成', source: 'test' } });
  assert.equal(evidence.status, 200);
  assert.equal(evidence.body.workflow.observedEvidence.length, 1);
  for (const endpoint of ['reconcile', 'resume', 'stop']) {
    const response = await handleOrchestrationRequest({ method: 'POST', pathname: `/api/orchestration/workflows/${id}/${endpoint}`, runtime, body: {} });
    assert.equal(response.status, 200);
  }
  assert.deepEqual(calls.map(([name]) => name), ['reconcile', 'resume', 'stop']);
});

test('routing catalog and per-workflow configuration APIs are Codex-only and safe', async () => {
  const { dir, runtime } = setup();
  const catalog = await handleOrchestrationRequest({ method: 'GET', pathname: '/api/orchestration/routing/catalog', runtime });
  assert.equal(catalog.status, 200);
  assert.deepEqual(catalog.body.supportedAgents, ['codex']);
  assert.equal(catalog.body.catalog.available, false);

  const created = await handleOrchestrationRequest({
    method: 'POST', pathname: '/api/orchestration/workflows', runtime,
    body: { projectPath: path.join(dir, 'app'), goal: 'route', agent: 'codex', verify: { dod: ['完成'] }, routingConfig: { enabled: true, preset: 'quality' } },
  });
  const id = created.body.workflow.id;
  const updated = await handleOrchestrationRequest({
    method: 'POST', pathname: `/api/orchestration/workflows/${id}/routing`, runtime,
    body: { config: { enabled: true, preset: 'custom', complexityTier: 'C2', thinkingTier: 'T2', prompt: 'drop me' } },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.routing.complexityTier, 'C2');
  assert.equal('prompt' in updated.body.routing, false);
  const current = await handleOrchestrationRequest({ method: 'GET', pathname: `/api/orchestration/workflows/${id}/routing`, runtime });
  assert.equal(current.body.config.thinkingTier, 'T2');
});

test('routing configuration rejects non-Codex workflows', async () => {
  const { dir, runtime } = setup();
  const created = await handleOrchestrationRequest({
    method: 'POST', pathname: '/api/orchestration/workflows', runtime,
    body: { projectPath: path.join(dir, 'app'), goal: 'route', agent: 'claude', verify: { dod: ['完成'] } },
  });
  await assert.rejects(
    handleOrchestrationRequest({ method: 'POST', pathname: `/api/orchestration/workflows/${created.body.workflow.id}/routing`, runtime, body: { enabled: true } }),
    (error) => error && error.code === 'ROUTING_AGENT_UNSUPPORTED',
  );
});

test('routing configuration accepts an injected second-agent adapter without agent-specific HTTP logic', async () => {
  const { dir, runtime } = setup();
  runtime.routing = createRoutingRuntime({
    agentCapabilities: {
      hermes: {
        listModels: async () => ({ models: [{ id: 'hermes-strong', supportedReasoningLevels: ['high'] }] }),
        applyProfile: async ({ profile }) => ({ readback: profile, verified: true }),
      },
    },
    cachePath: path.join(dir, 'second-agent-routing-cache.json'),
  });
  const created = runtime.store.create({
    projectPath: path.join(dir, 'hermes-app'), agent: 'hermes', mode: 'project',
    routingConfig: { enabled: true, preset: 'balanced' },
  });
  const current = await handleOrchestrationRequest({
    method: 'GET', pathname: `/api/orchestration/workflows/${created.id}/routing`, runtime,
  });
  assert.equal(current.status, 200);
  assert.equal(current.body.supported, true);
  assert.equal(current.body.catalog.models[0].id, 'hermes-strong');
  const updated = await handleOrchestrationRequest({
    method: 'POST', pathname: `/api/orchestration/workflows/${created.id}/routing`, runtime,
    body: { config: { enabled: true, preset: 'quality' } },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.workflow.routingConfig.enabled, true);
});

test('routing overview exposes safe diagnostics, audit timeline, usage state, and receipt', async () => {
  const { dir, runtime } = setup();
  const created = await handleOrchestrationRequest({
    method: 'POST', pathname: '/api/orchestration/workflows', runtime,
    body: {
      projectPath: path.join(dir, 'app'), goal: 'route', agent: 'codex', verify: { dod: ['完成'] },
      routingConfig: { enabled: true, preset: 'balanced', manualPin: { modelId: 'strong', reasoningLevel: 'high' } },
    },
  });
  const id = created.body.workflow.id;
  runtime.store.recordRouting(id, {
    summary: {
      enabled: true, action: 'apply', reasonCode: 'MANUAL_PIN', complexityTier: 'C1', thinkingTier: 'T1',
      promptPolicy: 'P1', modelId: 'strong', reasoningLevel: 'high', source: 'native', verified: true,
    },
    auditEvent: {
      schemaVersion: 1, event: 'profile_verified', generatedAt: '2026-08-30T12:00:00.000Z',
      fingerprint: 'route-1', route: { action: 'apply', reasonCode: 'MANUAL_PIN', complexityTier: 'C1', thinkingTier: 'T1', promptPolicy: 'P1' },
      profile: { modelId: 'strong', reasoningLevel: 'high', source: 'native', verified: true }, catalog: { source: 'native', stale: false },
      instruction: 'must not escape', token: 'must not escape',
    },
  });
  runtime.store.updateFields(id, {
    runReceipt: {
      version: 1, runId: id, agent: 'codex', goal: 'route', iterations: 1,
      dod: { passed: 0, total: 1 }, finalState: 'PAUSED', stopReason: 'Need Human',
      counters: { consecutiveFailures: 0, stagnation: 0, dispatchFailures: 0, routingEscalations: 0, routingDowngrades: 0 },
      routing: { modelId: 'strong', reasoningLevel: 'high', verified: true }, generatedAt: '2026-08-30T12:01:00.000Z',
      instruction: 'must not escape', token: 'must not escape',
    },
  }, 'test_receipt');

  const overview = await handleOrchestrationRequest({
    method: 'GET', pathname: `/api/orchestration/workflows/${id}/routing/overview`, runtime,
  });

  assert.equal(overview.status, 200);
  assert.equal(overview.body.diagnostics.workflowId, id);
  assert.equal(overview.body.diagnostics.compatibility.supported, true);
  assert.equal(overview.body.auditTimeline.length, 1);
  assert.equal(overview.body.auditTimeline[0].reasonCode, 'MANUAL_PIN');
  assert.equal(overview.body.usage.cost.available, false);
  assert.equal(overview.body.usage.quota.reasonCode, 'QUOTA_DATA_UNAVAILABLE');
  assert.equal(overview.body.receipt.runId, id);
  assert.equal(JSON.stringify(overview.body).includes('must not escape'), false);

  const audit = await handleOrchestrationRequest({
    method: 'GET', pathname: `/api/orchestration/workflows/${id}/routing/audit`, runtime,
  });
  assert.deepEqual(audit.body.items, overview.body.auditTimeline);
});

test('routing insights expose historical outcomes and workspace safety without blocking unavailable catalogs', async () => {
  const { dir, runtime } = setup();
  const created = await handleOrchestrationRequest({
    method: 'POST', pathname: '/api/orchestration/workflows', runtime,
    body: { projectPath: path.join(dir, 'app'), goal: 'insights', agent: 'codex', verify: { dod: ['完成'] } },
  });
  const id = created.body.workflow.id;
  runtime.store.appendDispatchRecord(id, {
    state: 'committed', routing: { modelId: 'strong', reasoningLevel: 'high' },
    instruction: 'must not escape', token: 'must not escape',
  });

  const response = await handleOrchestrationRequest({
    method: 'GET', pathname: `/api/orchestration/workflows/${id}/routing/insights`, runtime,
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.outcomes.totalSuccesses, 1);
  assert.deepEqual(response.body.workspace, { safe: true, reasonCode: 'WORKSPACE_IN_SCOPE' });
  assert.equal(response.body.recommendation.reasonCode, 'ROUTING_UNAVAILABLE');
  assert.equal(JSON.stringify(response.body).includes('must not escape'), false);
});

test('routing catalog refresh and profile test are explicit, safe, and never dispatch', async () => {
  const { dir, runtime } = setup();
  const calls = [];
  runtime.routing = {
    supportedAgents: () => ['codex'],
    getCatalog: async () => ({ source: 'native', available: true, stale: false, models: [{ id: 'strong' }] }),
    refreshCatalog: async ({ agent }) => { calls.push(['refresh', agent]); return { source: 'native', available: true, stale: false, models: [{ id: 'strong' }] }; },
    testProfile: async ({ modelId, reasoningLevel }) => {
      calls.push(['test', modelId, reasoningLevel]);
      return { ok: true, code: 'PROFILE_TEST_VERIFIED', profile: { modelId, reasoningLevel }, dispatchAllowed: false };
    },
  };
  const refresh = await handleOrchestrationRequest({
    method: 'POST', pathname: '/api/orchestration/routing/catalog/refresh', runtime, body: { agent: 'codex', command: 'drop' },
  });
  assert.equal(refresh.status, 200);
  assert.equal(refresh.body.catalog.source, 'native');
  assert.deepEqual(calls, [['refresh', 'codex']]);

  const created = await handleOrchestrationRequest({
    method: 'POST', pathname: '/api/orchestration/workflows', runtime,
    body: { projectPath: path.join(dir, 'app'), goal: 'test profile', agent: 'codex', verify: { dod: ['完成'] } },
  });
  const response = await handleOrchestrationRequest({
    method: 'POST', pathname: `/api/orchestration/workflows/${created.body.workflow.id}/routing/test`, runtime,
    body: { modelId: 'strong', reasoningLevel: 'high', instruction: 'drop' },
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.dispatchAllowed, false);
  assert.equal(JSON.stringify(response.body).includes('drop'), false);
  assert.deepEqual(calls, [['refresh', 'codex'], ['test', 'strong', 'high']]);
});

test('orchestration errors expose stable recovery codes', async () => {
  const { runtime } = setup();
  const response = await handleOrchestrationRequest({
    method: 'GET', pathname: '/api/orchestration/workflows/missing-workflow', runtime,
  });
  assert.equal(response.status, 404);
  assert.equal(response.body.code, 'WORKFLOW_NOT_FOUND');
});
