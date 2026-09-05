'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createOrchestrationRuntime, defaultWorkflowPath } = require('./runtime');
const { AutoPilotSettingsStore } = require('./settings-store');

test('orchestration runtime exposes separate Auto Loop and Suggest services', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-runtime-'));
  const runtime = createOrchestrationRuntime({
    env: { AGENT_BOARD_ALLOWED_ROOTS: dir, AGENT_BOARD_HEADLESS_EXECUTION: '0' },
    filePath: path.join(dir, 'workflows.json'),
    routingCachePath: path.join(dir, 'routing-cache.json'),
  });
  assert.equal(typeof runtime.auto.run, 'function');
  assert.equal(typeof runtime.auto.reconcile, 'function');
  assert.equal(typeof runtime.suggestion.suggest, 'function');
  assert.equal(typeof runtime.routing.getCatalog, 'function');
  assert.equal((await runtime.routing.getCatalog()).available, false);
  runtime.auto.stopPeriodicReconciliation();
});

test('orchestration runtime exposes the injected read-only researcher', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-runtime-'));
  const researcher = { research: async () => ({ status: 'completed', confidence: 1 }) };
  const runtime = createOrchestrationRuntime({
    env: { AGENT_BOARD_ALLOWED_ROOTS: dir, AGENT_BOARD_HEADLESS_EXECUTION: '0' },
    filePath: path.join(dir, 'workflows.json'), routingCachePath: path.join(dir, 'routing-cache.json'), researcher,
  });
  assert.equal(runtime.researcher, researcher);
  assert.equal(runtime.auto.researcher, researcher);
  runtime.auto.stopPeriodicReconciliation();
});

test('orchestration runtime accepts a bounded per-turn reconciliation interval', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-runtime-'));
  const runtime = createOrchestrationRuntime({
    env: {
      AGENT_BOARD_ALLOWED_ROOTS: dir,
      AGENT_BOARD_HEADLESS_EXECUTION: '0',
      AGENT_BOARD_AUTOPILOT_RECONCILE_TURNS: '4',
    },
    filePath: path.join(dir, 'workflows.json'),
    routingCachePath: path.join(dir, 'routing-cache.json'),
  });
  assert.equal(runtime.auto.reconcileEveryTurns, 4);
  runtime.auto.stopPeriodicReconciliation();
});

test('orchestration runtime uses the persisted reconciliation interval when env does not override it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-runtime-'));
  const settingsPath = path.join(dir, 'autopilot-settings.json');
  new AutoPilotSettingsStore(settingsPath).update({ autopilot: { reconciliationIntervalMs: 2_500 } });
  const runtime = createOrchestrationRuntime({
    env: { AGENT_BOARD_ALLOWED_ROOTS: dir, AGENT_BOARD_HEADLESS_EXECUTION: '0' },
    filePath: path.join(dir, 'workflows.json'), settingsPath, routingCachePath: path.join(dir, 'routing-cache.json'),
  });
  assert.equal(runtime.auto.reconciliationIntervalMs, 2_500);
  runtime.auto.stopPeriodicReconciliation();
});

test('orchestration runtime resolves its default workflow store below AB_DATA_DIR', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-data-'));
  assert.equal(defaultWorkflowPath({ AB_DATA_DIR: dataDir }), path.join(dataDir, 'workflows.json'));
});

test('orchestration runtime wires the advisory Supervisor review and supports an explicit opt-out', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-runtime-'));
  const review = async () => ({ source: 'deterministic', review: null });
  const runtime = createOrchestrationRuntime({
    env: { AGENT_BOARD_ALLOWED_ROOTS: dir, AGENT_BOARD_HEADLESS_EXECUTION: '0' },
    filePath: path.join(dir, 'workflows.json'), routingCachePath: path.join(dir, 'routing-cache.json'), supervisorReview: review,
  });
  assert.equal(runtime.auto.supervisorReview, review);
  assert.equal(typeof runtime.auto.evidenceCollector, 'function');
  runtime.auto.stopPeriodicReconciliation();

  const disabled = createOrchestrationRuntime({
    env: { AGENT_BOARD_ALLOWED_ROOTS: dir, AGENT_BOARD_HEADLESS_EXECUTION: '0', AGENT_BOARD_SUPERVISOR_REVIEW: '0' },
    filePath: path.join(dir, 'disabled-workflows.json'), routingCachePath: path.join(dir, 'disabled-routing-cache.json'),
  });
  assert.equal(disabled.auto.supervisorReview, null);
  disabled.auto.stopPeriodicReconciliation();
});

test('orchestration runtime subscribes AutoLoop to assistant-message ingestion events', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-runtime-'));
  let listener = null;
  const sessionStore = {
    onMessageIngested(callback) { listener = callback; return () => { listener = null; }; },
  };
  const runtime = createOrchestrationRuntime({
    env: { AGENT_BOARD_ALLOWED_ROOTS: dir, AGENT_BOARD_HEADLESS_EXECUTION: '0' },
    filePath: path.join(dir, 'workflows.json'), routingCachePath: path.join(dir, 'routing-cache.json'), sessionStore,
  });
  assert.equal(typeof listener, 'function');
  assert.equal(typeof runtime.stopSessionActivityMonitor, 'function');
  runtime.stopSessionActivityMonitor();
  assert.equal(listener, null);
  runtime.auto.stopPeriodicReconciliation();
});
