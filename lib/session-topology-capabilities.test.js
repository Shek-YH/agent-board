'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { AGENT_TOPOLOGY_CAPABILITIES } = require('./session-topology');

test('all supported agents default to a verified controllable main session', () => {
  const supported = ['claude', 'zcode', 'codex', 'deepseek', 'workbuddy', 'marvis', 'pi', 'hermes'];
  for (const agent of supported) {
    assert.equal(AGENT_TOPOLOGY_CAPABILITIES[agent].childDetection, 'verified');
    assert.equal(AGENT_TOPOLOGY_CAPABILITIES[agent].defaultRole, 'main');
    assert.equal(AGENT_TOPOLOGY_CAPABILITIES[agent].defaultControl, 'eligible');
  }
  assert.equal(AGENT_TOPOLOGY_CAPABILITIES.claude.childDetection, 'verified');
  assert.equal(AGENT_TOPOLOGY_CAPABILITIES.zcode.childDetection, 'verified');
  assert.equal(AGENT_TOPOLOGY_CAPABILITIES.codex.childDetection, 'verified');
  assert.equal(AGENT_TOPOLOGY_CAPABILITIES.codex.defaultControl, 'eligible');
});

test('capability evidence names each adapter’s durable topology signal', () => {
  assert.deepEqual(AGENT_TOPOLOGY_CAPABILITIES.deepseek.evidence, [
    "origin='subagent'", 'subagent/descriptor', 'parentSession',
  ]);
  assert.deepEqual(AGENT_TOPOLOGY_CAPABILITIES.workbuddy.evidence, ['subagents path', 'child UUID']);
  assert.deepEqual(AGENT_TOPOLOGY_CAPABILITIES.marvis.evidence, ['messages.metadata.subagent.id']);
  assert.deepEqual(AGENT_TOPOLOGY_CAPABILITIES.pi.evidence, ['subagents path']);
  assert.deepEqual(AGENT_TOPOLOGY_CAPABILITIES.hermes.evidence, ['exact delegate_task call/result projection']);
});

test('each supported adapter normalizes an explicit child as blocked', () => {
  const { normalizeTopologyMessage } = require('./session-topology');
  for (const agent of ['deepseek', 'workbuddy', 'marvis', 'pi', 'hermes']) {
    const topology = normalizeTopologyMessage({
      agent,
      sessionId: `${agent}-child`,
      sessionRole: 'child',
      parentSessionId: `${agent}-main`,
      rootSessionId: `${agent}-main`,
      topologySource: 'explicit',
      childDetection: 'verified',
    });
    assert.equal(topology.session_role, 'child');
    assert.equal(topology.control_eligibility, 'blocked');
    assert.equal(topology.parent_session_ref, `${agent}:${agent}-main`);
    assert.equal(topology.root_session_ref, `${agent}:${agent}-main`);
  }
});
