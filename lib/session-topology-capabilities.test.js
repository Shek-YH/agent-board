'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { AGENT_TOPOLOGY_CAPABILITIES } = require('./session-topology');

test('capability matrix makes unsupported child detection visible and conservative', () => {
  const unsupported = ['deepseek', 'workbuddy', 'marvis', 'pi', 'hermes'];
  for (const agent of unsupported) {
    assert.equal(AGENT_TOPOLOGY_CAPABILITIES[agent].childDetection, 'unsupported');
    assert.equal(AGENT_TOPOLOGY_CAPABILITIES[agent].defaultControl, 'manual_only');
  }
  assert.equal(AGENT_TOPOLOGY_CAPABILITIES.claude.childDetection, 'verified');
  assert.equal(AGENT_TOPOLOGY_CAPABILITIES.zcode.childDetection, 'verified');
  assert.equal(AGENT_TOPOLOGY_CAPABILITIES.codex.childDetection, 'verified');
  assert.equal(AGENT_TOPOLOGY_CAPABILITIES.codex.defaultControl, 'eligible');
});
