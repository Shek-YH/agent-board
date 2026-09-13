'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { loadAgentManifest, loadAllAgentManifests } = require('./manifest');

test('Codex and WorkBuddy manifests declare capabilities, authority and centralized timeouts', () => {
  const codex = loadAgentManifest('codex');
  const workbuddy = loadAgentManifest('workbuddy');
  assert.equal(codex.agent, 'codex');
  assert.equal(codex.capabilities.jsonl, true);
  assert.equal(workbuddy.agent, 'workbuddy');
  assert.equal(workbuddy.capabilities.hooks, true);
  assert.equal(workbuddy.authority.sessionLifecycle[0], 'native_hook');
  assert.equal(workbuddy.timeouts.processDeadMs, 6000);
  assert.ok(Object.isFrozen(codex));
});

test('all current agent manifests are explicit and unknown manifests fail closed', () => {
  const manifests = loadAllAgentManifests();
  assert.ok(manifests.codex && manifests.workbuddy);
  assert.ok(manifests.claude && manifests.pi && manifests.hermes && manifests.zcode && manifests.marvis && manifests.deepseek);
  assert.throws(() => loadAgentManifest('../secrets'), /agent manifest/);
});
