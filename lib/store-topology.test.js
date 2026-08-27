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
