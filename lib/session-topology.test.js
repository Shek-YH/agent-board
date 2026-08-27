'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  AGENT_TOPOLOGY_CAPABILITIES,
  normalizeTopologyMessage,
  mergeTopology,
  resolveControlTarget,
  summarizeTopology,
} = require('./session-topology');

test('explicit child topology normalizes parent and root refs', () => {
  const topology = normalizeTopologyMessage({
    agent: 'claude',
    sessionId: 'child-agent-1',
    sessionRole: 'child',
    parentSessionId: 'main-1',
    topologySource: 'explicit',
  });

  assert.deepEqual(topology, {
    session_role: 'child',
    parent_session_ref: 'claude:main-1',
    root_session_ref: 'claude:main-1',
    topology_source: 'explicit',
    topology_confidence: 1,
    child_detection: 'verified',
    control_eligibility: 'blocked',
  });
});

test('missing topology uses the Codex verified adapter default', () => {
  const topology = normalizeTopologyMessage({ agent: 'codex', sessionId: 'thread-1' });
  assert.equal(topology.session_role, 'main');
  assert.equal(topology.root_session_ref, 'codex:thread-1');
  assert.equal(topology.child_detection, 'verified');
  assert.equal(topology.control_eligibility, 'eligible');
});

test('all current agents have an explicit capability declaration', () => {
  assert.deepEqual(Object.keys(AGENT_TOPOLOGY_CAPABILITIES).sort(), [
    'claude', 'codex', 'deepseek', 'hermes', 'marvis', 'pi', 'workbuddy', 'zcode',
  ]);
  assert.equal(AGENT_TOPOLOGY_CAPABILITIES.claude.childDetection, 'verified');
  assert.equal(AGENT_TOPOLOGY_CAPABILITIES.zcode.childDetection, 'verified');
  assert.equal(AGENT_TOPOLOGY_CAPABILITIES.codex.childDetection, 'verified');
});

test('child topology cannot be downgraded by a later structural main signal', () => {
  const child = mergeTopology({
    session_role: 'child',
    parent_session_ref: 'claude:main-1',
    topology_source: 'explicit',
    topology_confidence: 1,
    child_detection: 'verified',
    control_eligibility: 'blocked',
  }, normalizeTopologyMessage({ agent: 'claude', sessionId: 'child-1', sessionRole: 'main', topologySource: 'structural' }));
  assert.equal(child.session_role, 'child');
  assert.equal(child.parent_session_ref, 'claude:main-1');
  assert.equal(child.control_eligibility, 'blocked');
});

test('strict resolver returns the only eligible main session', () => {
  const result = resolveControlTarget([
    { id: 'claude:main-1', agent: 'claude', project: 'C:\\Projects\\demo', session_role: 'main', control_eligibility: 'eligible' },
    { id: 'claude:child-1', agent: 'claude', project: 'C:\\Projects\\demo', session_role: 'child', parent_session_ref: 'claude:main-1', control_eligibility: 'blocked' },
  ], { agent: 'claude', project: 'c:/projects/demo' });
  assert.equal(result.status, 'resolved');
  assert.equal(result.target.sessionRef, 'claude:main-1');
});

test('strict resolver refuses ambiguous main sessions', () => {
  const result = resolveControlTarget([
    { id: 'claude:main-1', agent: 'claude', project: 'C:\\Projects\\demo', session_role: 'main', control_eligibility: 'eligible' },
    { id: 'claude:main-2', agent: 'claude', project: 'C:\\Projects\\demo', session_role: 'main', control_eligibility: 'eligible' },
  ], { agent: 'claude', project: 'C:/Projects/demo' });
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.target, null);
  assert.equal(result.candidates.length, 2);
});

test('strict resolver blocks an explicitly requested child', () => {
  const result = resolveControlTarget([
    { id: 'claude:main-1', agent: 'claude', project: 'C:\\Projects\\demo', session_role: 'main', control_eligibility: 'eligible' },
    { id: 'claude:child-1', agent: 'claude', project: 'C:\\Projects\\demo', session_role: 'child', parent_session_ref: 'claude:main-1', control_eligibility: 'blocked' },
  ], { sessionRef: 'claude:child-1' });
  assert.equal(result.status, 'blocked');
  assert.equal(result.target, null);
  assert.equal(result.reason.includes('子代理'), true);
});

test('topology summary counts children and recent active children', () => {
  const now = 1_000_000;
  const summary = summarizeTopology([
    { id: 'claude:main-1', session_role: 'main' },
    { id: 'claude:child-1', session_role: 'child', parent_session_ref: 'claude:main-1', last_seen: now - 1000 },
    { id: 'claude:child-2', session_role: 'child', parent_session_ref: 'claude:main-1', last_seen: now - 20 * 60 * 1000 },
  ], now);
  assert.deepEqual(summary.get('claude:main-1'), { child_count: 2, active_child_count: 1 });
});
