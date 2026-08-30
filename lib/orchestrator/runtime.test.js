'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createOrchestrationRuntime } = require('./runtime');

test('orchestration runtime exposes separate Auto Loop and Suggest services', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-runtime-'));
  const runtime = createOrchestrationRuntime({
    env: { AGENT_BOARD_ALLOWED_ROOTS: dir, AGENT_BOARD_HEADLESS_EXECUTION: '0' },
    filePath: path.join(dir, 'workflows.json'),
  });
  assert.equal(typeof runtime.auto.run, 'function');
  assert.equal(typeof runtime.auto.reconcile, 'function');
  assert.equal(typeof runtime.suggestion.suggest, 'function');
  runtime.auto.stopPeriodicReconciliation();
});

