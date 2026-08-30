'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const store = require('../test-support/store-fixture');

test('官方 WorkBuddy runtime 状态覆盖旧的消息活跃窗口', () => {
  store.clearAll();
  const sessionId = 'unit-runtime-authority';
  const ref = `workbuddy:${sessionId}`;
  const now = Date.now();
  store.ingest({
    agent: 'workbuddy', sourceId: 'runtime-authority-user', sessionId,
    ts: now, role: 'user', kind: 'message', text: '执行任务',
  });

  store.noteWorkBuddyRuntimeStatus(ref, {
    sessionId,
    state: 'running',
    lastEventAt: now,
    source: 'workbuddy_hooks',
  });
  assert.equal(store.isLiveRef(ref, now), true);
  assert.equal(store.getRuntimeStatuses(now)[ref].state, 'running');

  store.noteWorkBuddyRuntimeStatus(ref, {
    sessionId,
    state: 'completed',
    lastEventAt: now + 1,
    completedAt: now + 1,
    source: 'workbuddy_hooks',
  });
  assert.equal(store.isLiveRef(ref, now + 1), false);
  assert.equal(store.getSession(ref).runtime_status.state, 'completed');

  store.noteWorkBuddyRuntimeStatus(ref, {
    sessionId,
    state: 'waiting_user_input',
    lastEventAt: now + 2,
    source: 'workbuddy_hooks',
  });
  assert.equal(store.isLiveRef(ref, now + 2), false);
  assert.equal(store.getSessions({ agent: 'workbuddy' })[0].runtime_status.state, 'waiting_user_input');

  store.clearAll();
});
