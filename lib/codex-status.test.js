'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createCodexRuntimeState,
  applyCodexTurnEvent,
  applyCodexThreadStatus,
  getCodexDisplayStatus,
} = require('./codex-status');

test('完成观察期内保持运行，观察期结束后才标记完成', () => {
  let state = createCodexRuntimeState('thread-1');
  state = applyCodexTurnEvent(state, {
    kind: 'turn_start', turnId: 'turn-1', ts: 1000,
  });
  state = applyCodexTurnEvent(state, {
    kind: 'turn_end', turnId: 'turn-1', turnStatus: 'completed', ts: 2000, holdMs: 5000,
  });

  assert.equal(getCodexDisplayStatus(state, 6999), 'running');
  assert.equal(getCodexDisplayStatus(state, 7000), 'completed');
  assert.equal(state.latestTurnId, 'turn-1');
  assert.equal(state.latestTurnStatus, 'completed');
});

test('线程等待标记优先映射为待审批或待输入', () => {
  let state = createCodexRuntimeState('thread-2');
  state = applyCodexThreadStatus(state, {
    type: 'active', activeFlags: ['waitingOnApproval'],
  }, 1000);
  assert.equal(getCodexDisplayStatus(state, 1000), 'waiting_approval');

  state = applyCodexThreadStatus(state, {
    type: 'active', activeFlags: ['waitingOnUserInput'],
  }, 2000);
  assert.equal(getCodexDisplayStatus(state, 2000), 'waiting_user_input');
});

test('中断和失败回合分别保留终态', () => {
  let state = createCodexRuntimeState('thread-3');
  state = applyCodexTurnEvent(state, {
    kind: 'turn_end', turnId: 'turn-interrupted', turnStatus: 'interrupted', ts: 1000,
  });
  assert.equal(getCodexDisplayStatus(state, 1000), 'interrupted');

  state = applyCodexTurnEvent(state, {
    kind: 'turn_end', turnId: 'turn-failed', turnStatus: 'failed', ts: 2000,
  });
  assert.equal(getCodexDisplayStatus(state, 2000), 'failed');
});

test('store.ingest 转发的 completionHoldMs 字段名同样进入完成观察期', () => {
  // codex.js parseLines 的 task_complete 事件字段是 completionHoldMs；store 把该事件原样
  // 交给 applyCodexTurnEvent。若只认 holdMs，观察窗内 runtime_status 会提前显示 completed。
  let state = createCodexRuntimeState('thread-4');
  state = applyCodexTurnEvent(state, {
    kind: 'turn_start', turnId: 'turn-4', ts: 1000,
  });
  state = applyCodexTurnEvent(state, {
    kind: 'turn_end', turnId: 'turn-4', turnStatus: 'completed', ts: 2000, completionHoldMs: 5000,
  });

  assert.equal(getCodexDisplayStatus(state, 6999), 'running');
  assert.equal(getCodexDisplayStatus(state, 7000), 'completed');
  assert.equal(state.pendingCompletionAt, 7000);
});
