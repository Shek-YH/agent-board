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

test('store handles identical turn-end source IDs independently per session', () => {
  store.clearAll();
  const now = Date.now();
  for (const sessionId of ['deepseek-turn-a', 'deepseek-turn-b']) {
    store.ingest({
      agent: 'deepseek', sourceId: `${sessionId}:u:1`, sessionId,
      ts: now - 1_000, role: 'user', kind: 'message', text: 'run',
    });
    store.ingest({
      agent: 'deepseek', sourceId: 'turnend:shared-seq', sessionId,
      ts: now, kind: 'turn_end', turnStatus: 'completed',
    });
  }

  assert.equal(store.isLiveRef('deepseek:deepseek-turn-a', now + 1), false);
  assert.equal(store.isLiveRef('deepseek:deepseek-turn-b', now + 1), false);
  store.clearAll();
});

test('a newer turn-start activity clears an earlier completion signal', () => {
  store.clearAll();
  const now = Date.now();
  const ref = 'workbuddy:turn-start-reopen';
  store.ingest({
    agent: 'workbuddy', sourceId: 'assistant:1', sessionId: 'turn-start-reopen',
    ts: now - 1_000, role: 'assistant', kind: 'message', text: '先调用工具',
  });
  store.ingest({
    agent: 'workbuddy', sourceId: 'assistant:1:turnend', sessionId: 'turn-start-reopen',
    ts: now, kind: 'turn_end', turnStatus: 'completed',
  });
  assert.equal(store.isLiveRef(ref, now + 1), false);

  store.ingest({
    agent: 'workbuddy', sourceId: 'tool-call:1', sessionId: 'turn-start-reopen',
    ts: now + 1, kind: 'turn_start',
  });
  assert.equal(store.isLiveRef(ref, now + 2), true);
  store.clearAll();
});
