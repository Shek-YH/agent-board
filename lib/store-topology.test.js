'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const store = require('../test-support/store-fixture');

test('store persists topology fields and exposes child counts on session cards', () => {
  const now = Date.now();
  store.ingest({
    agent: 'claude', sourceId: 'topology-main', sessionId: 'topology-main',
    ts: now - 1000, role: 'user', kind: 'message', text: 'main', project: 'C:\\Projects\\topology',
  });
  store.ingest({
    agent: 'claude', sourceId: 'topology-child', sessionId: 'topology-main:subagent:agent-1',
    parentSessionId: 'topology-main', rootSessionId: 'topology-main', sessionRole: 'child',
    topologySource: 'explicit', childDetection: 'verified', controlEligibility: 'blocked',
    ts: now, role: 'assistant', kind: 'message', text: 'child', project: 'C:\\Projects\\topology',
  });

  const cards = store.getSessions({ agent: 'claude', project: 'C:\\Projects\\topology', limit: 10 });
  const main = cards.find((card) => card.session_role === 'main');
  const child = cards.find((card) => card.session_role === 'child');
  assert.equal(main.child_count, 1);
  assert.equal(main.active_child_count, 1);
  assert.equal(child.parent_session_ref, 'claude:topology-main');
  assert.equal(child.control_eligibility, 'blocked');
});

test('active snapshots expose topology role for completion notifications', () => {
  const now = Date.now();
  store.ingest({
    agent: 'codex', sourceId: 'active-main', sessionId: 'active-main',
    ts: now - 1000, role: 'user', kind: 'message', text: 'main', project: 'C:\\Projects\\active-topology',
  });
  store.ingest({
    agent: 'codex', sourceId: 'active-child', sessionId: 'active-main:subagent:child',
    parentSessionId: 'active-main', rootSessionId: 'active-main', sessionRole: 'child',
    topologySource: 'explicit', childDetection: 'verified', controlEligibility: 'blocked',
    ts: now, role: 'assistant', kind: 'message', text: 'child', project: 'C:\\Projects\\active-topology',
  });

  const active = store.getActive();
  const child = active.find((item) => item.sessionRef === 'codex:active-main:subagent:child');
  assert.equal(child.session_role, 'child');
  assert.equal(child.parent_session_ref, 'codex:active-main');
});

test('store strict control resolver never falls back to child or recent session', () => {
  const child = store.resolveSessionControlTarget({ sessionRef: 'claude:topology-main:subagent:agent-1' });
  assert.equal(child.status, 'blocked');
  const main = store.resolveSessionControlTarget({ agent: 'claude', project: 'C:/Projects/topology' });
  assert.equal(main.status, 'resolved');
  assert.equal(main.target.sessionRef, 'claude:topology-main');
});

test('store keeps native and synthetic child cards linked to their agent parent', () => {
  const now = Date.now();
  const cases = [
    ['workbuddy', 'wb-main', 'wb-main:subagent:child-uuid'],
    ['deepseek', 'ds-main', 'ds-child'],
    ['marvis', 'mv-main', 'mv-main:subagent:sa-1'],
    ['pi', 'pi-main', 'pi-child'],
    ['hermes', 'hm-main', 'hm-main:subagent:call-1:0'],
  ];
  for (const [agent, parent, child] of cases) {
    const project = `C:/Projects/${agent}-topology`;
    store.ingest({
      agent, sourceId: `${parent}-msg`, sessionId: parent,
      ts: now - 2_000, role: 'user', kind: 'message', text: `${agent} main`, project,
    });
    store.ingest({
      agent, sourceId: `${child}-msg`, sessionId: child,
      parentSessionId: parent, rootSessionId: parent, sessionRole: 'child',
      topologySource: 'explicit', childDetection: 'verified', controlEligibility: 'blocked',
      ts: now - 1_000, role: 'assistant', kind: 'message', text: `${agent} child`, project,
    });
    const cards = store.getSessions({ agent, project, limit: 10 });
    const main = cards.find((card) => card.session_id === parent);
    const childCard = cards.find((card) => card.session_id === child);
    assert.ok(main, `${agent} parent card should be retained`);
    assert.ok(childCard, `${agent} child card should be retained`);
    assert.equal(main.child_count, 1, `${agent} parent should aggregate one child`);
    assert.equal(main.active_child_count, 1, `${agent} parent should aggregate active child`);
    assert.equal(childCard.parent_session_ref, `${agent}:${parent}`);
    assert.equal(childCard.root_session_ref, `${agent}:${parent}`);
    assert.equal(childCard.control_eligibility, 'blocked');
  }
});

test('onlyUser 保留由用户发起主会话下的子代理卡片', () => {
  const now = Date.now();
  const project = 'C:/Projects/only-user-child';
  store.ingest({
    agent: 'marvis', sourceId: 'only-user-parent', sessionId: 'only-user-parent',
    ts: now - 2_000, role: 'user', kind: 'message', text: '发起子代理测试', project,
  });
  store.ingest({
    agent: 'marvis', sourceId: 'only-user-child', sessionId: 'only-user-parent:subagent:sa-1',
    parentSessionId: 'only-user-parent', rootSessionId: 'only-user-parent', sessionRole: 'child',
    topologySource: 'explicit', childDetection: 'verified', controlEligibility: 'blocked',
    ts: now - 1_000, role: 'assistant', kind: 'message', text: '子代理结果', project,
  });

  const cards = store.getSessions({ agent: 'marvis', project, onlyUser: true, limit: 10 });
  assert.deepEqual(cards.map((card) => card.session_id).sort(), [
    'only-user-parent',
    'only-user-parent:subagent:sa-1',
  ].sort());
});
