'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { getHeartbeatTransition } = require('./adapters/workbuddy');
const store = require('./store');
const { shouldAdvanceSessionTime, isExternalCompletionActive, noteExternalStatus } = store;

test('新鲜但尚未前进的 WorkBuddy 心跳不会把会话标记为已完成', () => {
  assert.equal(getHeartbeatTransition({
    previousHeartbeat: 1_000,
    heartbeat: 1_000,
    now: 60_000,
    tracked: true,
  }), 'unchanged');
});

test('持续跟踪的 WorkBuddy 心跳超过新鲜窗口后才标记为停止', () => {
  assert.equal(getHeartbeatTransition({
    previousHeartbeat: 1_000,
    heartbeat: 1_000,
    now: 91_001,
    tracked: true,
  }), 'stopped');
});

test('心跳和标题元数据不会推进会话的真实 last_seen', () => {
  assert.equal(shouldAdvanceSessionTime('heartbeat'), false);
  assert.equal(shouldAdvanceSessionTime('title'), false);
  assert.equal(shouldAdvanceSessionTime('message'), true);
});

test('外部 WorkBuddy 终态只在没有更新消息时阻止活跃', () => {
  assert.equal(isExternalCompletionActive(100, 100), true);
  assert.equal(isExternalCompletionActive(99, 100), true);
  assert.equal(isExternalCompletionActive(101, 100), false);
  assert.equal(isExternalCompletionActive(0, 100), true);
});

test('外部 WorkBuddy 状态只接受单调前进的终态时间', () => {
  const ref = 'workbuddy:unit-external-status';
  assert.equal(noteExternalStatus(ref, { terminal: true, statusAt: 100 }), true);
  assert.equal(noteExternalStatus(ref, { terminal: true, statusAt: 99 }), false);
  assert.equal(noteExternalStatus(ref, { active: true, statusAt: 100 }), true);
});

test('外部 WorkBuddy active 状态可维持长时间运行会话为进行中', () => {
  store.clearAll();
  const sessionId = 'unit-long-running-workbuddy-session';
  const ref = `workbuddy:${sessionId}`;
  const now = Date.now();
  store.ingest({
    agent: 'workbuddy', sourceId: 'unit-user-message', sessionId,
    ts: now - 11 * 60 * 1000, role: 'user', kind: 'message', text: '继续执行',
  });

  assert.equal(store.isLiveRef(ref, now), false);
  assert.equal(noteExternalStatus(ref, { active: true, statusAt: now }), true);
  assert.equal(store.isLiveRef(ref, now), true);

  store.clearAll();
});
