'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { loadAgentManifest } = require('./manifest');
const { validateAgentMonitorAdapter, createAgentMonitorAdapter } = require('./adapter-contract');
const { createCodexStateAdapter } = require('../agent-adapters/codex-state-adapter');

test('Codex Evidence adapter binds to the common manifest-backed contract', () => {
  const adapter = createCodexStateAdapter({ mode: 'shadow' });
  const checked = validateAgentMonitorAdapter(adapter, loadAgentManifest('codex'));
  assert.equal(checked.agentId, 'codex');
  assert.equal(checked.capabilities.jsonl, true);
  assert.equal(typeof checked.collectEvidence, 'function');
});

test('adapter contract requires a matching manifest and evidence collector', () => {
  const manifest = loadAgentManifest('codex');
  assert.throws(() => validateAgentMonitorAdapter({ agentId: 'workbuddy', collectEvidence() {} }, manifest), /agentId/);
  assert.throws(() => validateAgentMonitorAdapter({ agentId: 'codex' }, manifest), /collectEvidence/);
  assert.throws(() => createAgentMonitorAdapter({ agentId: 'codex', manifest, writeUiState() {}, collectEvidence() {} }), /direct state/);
});

test('contract returns safe capability metadata without exposing implementation details', () => {
  const adapter = createAgentMonitorAdapter({
    agentId: 'codex',
    manifest: loadAgentManifest('codex'),
    collectEvidence() { return []; },
    discoverSessions: async () => [],
  });
  assert.deepEqual(Object.keys(adapter).sort(), ['agentId', 'capabilities', 'collectEvidence', 'discoverSessions']);
  assert.equal(Object.hasOwn(adapter, 'manifest'), false);
  assert.equal(Object.isFrozen(adapter.capabilities), true);
});
