'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createRuntimeStore } = require('./runtime-store');
const {
  applyStoreMessage,
  applyExternalStatus,
  applyHeartbeat,
  applyManualCompletion,
  applyCompletionConfirmed,
  applyWorkBuddyRuntimeStatus,
} = require('./adapter-bridge');

// 本文件里的事件时间戳是纯数字（100/200/...），并不是真实的 epoch ms。
// 引擎的 staleMs 老化按「读取时刻 - 状态更新时刻」判断，读取时刻来自注入的 clock。
// 因此每次创建 store 都必须显式给 clock，否则真实 Date.now() 会把 ts=200 判成早已过期，
// snapshot 全部降级为 IDLE（历史上这正是本文件三个断言失败的成因）。
const MS = 1000;
const fresh = (opts = {}) => createRuntimeStore({ staleMs: 30 * 60 * MS, ...opts });

test('Codex and WorkBuddy adapter evidence becomes normalized lifecycle state', () => {
  // 固定时钟在事件时间之后一点点，仍在 staleMs 内 → 状态必须保持非老化投影。
  let now = 210;
  const runtime = fresh({ stabilizationMs: 0, clock: () => now });
  applyStoreMessage(runtime, {
    agent: 'codex', sessionId: 'c1', sourceId: 'turn-1', kind: 'turn_start', ts: 100, turnId: 't1',
  });
  applyStoreMessage(runtime, {
    agent: 'codex', sessionId: 'c1', sourceId: 'turn-1-done', kind: 'turn_end', ts: 200, turnId: 't1',
  });
  // stabilizationMs: 0 → 读取时的 advance() 立即把完成候选确认为终态。
  assert.equal(runtime.snapshot('codex:c1').publicState, 'COMPLETED');
  assert.equal(runtime.snapshot('codex:c1').stale, false);

  applyStoreMessage(runtime, {
    agent: 'workbuddy', sessionId: 'w1', sourceId: 'user-1', kind: 'message', role: 'user', ts: 300,
  });
  assert.equal(runtime.snapshot('workbuddy:w1').publicState, 'ACTIVE');

  // 老化契约：同一会话超过 staleMs 后降级为 IDLE，且带 stale 标记。
  now = 300 + 31 * 60 * MS;
  assert.equal(runtime.snapshot('workbuddy:w1').publicState, 'IDLE');
  assert.equal(runtime.snapshot('workbuddy:w1').stale, true);
  // 终态不受老化影响。
  assert.equal(runtime.snapshot('codex:c1').publicState, 'COMPLETED');
});

test('external terminal, heartbeat, and manual completion share idempotent event semantics', () => {
  let now = 210;
  const runtime = fresh({ stabilizationMs: 0, clock: () => now });
  applyExternalStatus(runtime, 'workbuddy:w1', { statusAt: 100, terminal: true, status: 'completed' });
  applyExternalStatus(runtime, 'workbuddy:w1', { statusAt: 100, terminal: true, status: 'completed' });
  assert.equal(runtime.snapshot('workbuddy:w1').publicState, 'COMPLETED');
  applyHeartbeat(runtime, 'workbuddy:w1', true, 90);
  assert.equal(runtime.snapshot('workbuddy:w1').publicState, 'COMPLETED');
  applyManualCompletion(runtime, 'workbuddy:w1', 200);
  assert.equal(runtime.snapshot('workbuddy:w1').publicState, 'COMPLETED');
  // 终态在老化窗口之后依然是终态（不得被降级回 IDLE）。
  now = 200 + 31 * 60 * MS;
  assert.equal(runtime.snapshot('workbuddy:w1').publicState, 'COMPLETED');
});

test('completion confirmation closes an existing completion candidate', () => {
  let now = 100;
  // 稳定窗故意设成 5s：100ms 内读取必须仍是候选态，5s 后必须被 advance() 确认为终态。
  const runtime = fresh({ stabilizationMs: 5000, clock: () => now });
  applyStoreMessage(runtime, {
    agent: 'codex', sessionId: 'c1', sourceId: 'turn-1', kind: 'turn_end', ts: 100,
  });
  assert.equal(runtime.snapshot('codex:c1').publicState, 'COMPLETION_CANDIDATE');

  // 显式完成确认可立即关闭候选态，无需等稳定窗。
  applyCompletionConfirmed(runtime, 'codex:c1', 100);
  assert.equal(runtime.snapshot('codex:c1').publicState, 'COMPLETED');
});

test('an unconfirmed completion candidate converges once the stabilization window elapses', () => {
  let now = 100;
  const runtime = fresh({ stabilizationMs: 5000, clock: () => now });
  applyStoreMessage(runtime, {
    agent: 'codex', sessionId: 'c1', sourceId: 'turn-1', kind: 'turn_end', ts: 100,
  });
  assert.equal(runtime.snapshot('codex:c1').publicState, 'COMPLETION_CANDIDATE');
  assert.equal(runtime.snapshot('codex:c1').stale, false);
  // 稳定窗内仍是候选。
  now = 100 + 4999;
  assert.equal(runtime.snapshot('codex:c1').publicState, 'COMPLETION_CANDIDATE');
  // 稳定窗过后自动收敛为终态（旧实现从不调用 advance()，会永远卡在候选态）。
  now = 100 + 5000;
  assert.equal(runtime.snapshot('codex:c1').publicState, 'COMPLETED');
});

test('an abandoned completion candidate is aged out instead of pinning the session live', () => {
  let now = 100;
  // 稳定窗远大于老化窗：确认路径来不及生效，老化必须兜底为 IDLE（= 非 live）。
  const runtime = fresh({ stabilizationMs: 24 * 60 * 60 * MS, clock: () => now });
  applyStoreMessage(runtime, {
    agent: 'codex', sessionId: 'c1', sourceId: 'turn-1', kind: 'turn_end', ts: 100,
  });
  assert.equal(runtime.snapshot('codex:c1').publicState, 'COMPLETION_CANDIDATE');
  now = 100 + 31 * 60 * MS;
  const snap = runtime.snapshot('codex:c1');
  assert.equal(snap.publicState, 'IDLE');
  assert.equal(snap.stale, true);
  // 老化只影响投影，内部证据保留，便于诊断。
  assert.equal(runtime.get('codex:c1').getInternalState().publicState, 'COMPLETION_CANDIDATE');
});

test('WorkBuddy runtime states map to public lifecycle states', () => {
  let now = 210;
  const runtime = fresh({ stabilizationMs: 0, clock: () => now });
  applyWorkBuddyRuntimeStatus(runtime, 'workbuddy:w1', { state: 'waiting_user', lastEventAt: 100 });
  assert.equal(runtime.snapshot('workbuddy:w1').publicState, 'WAITING_USER');
  applyWorkBuddyRuntimeStatus(runtime, 'workbuddy:w1', { state: 'completed', lastEventAt: 200 });
  assert.equal(runtime.snapshot('workbuddy:w1').publicState, 'COMPLETED');

  // 陈旧的 waiting_user 不得把会话永久钉在 live 窗口里。
  // 注意：这里必须用显式 now 观测，且「未过期」探针要严格落在窗口内侧
  // （staleMs 是闭区间的起点，恰好等于 staleMs 就已经算过期）。
  const aged = fresh({ stabilizationMs: 0, clock: () => 100 });
  applyWorkBuddyRuntimeStatus(aged, 'workbuddy:w2', { state: 'waiting_user', lastEventAt: 100 });
  assert.equal(aged.snapshot('workbuddy:w2', 100).publicState, 'WAITING_USER');
  assert.equal(aged.snapshot('workbuddy:w2', 100 + 29 * 60 * MS).publicState, 'WAITING_USER');
  assert.equal(aged.snapshot('workbuddy:w2', 100 + 31 * 60 * MS).publicState, 'IDLE');
  assert.equal(aged.snapshot('workbuddy:w2', 100 + 31 * 60 * MS).stale, true);
});
