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
