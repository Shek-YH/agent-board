'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createSessionLifecycleEngine } = require('./engine');
const { createRuntimeStore } = require('./runtime-store');

const base = (type, timestamp, eventId = `${type}:${timestamp}`) => ({
  schemaVersion: 1,
  eventId,
  agent: 'workbuddy',
  sessionRef: 'workbuddy:session-1',
  sessionId: 'session-1',
  timestamp,
  type,
  source: 'test',
});

test('engine confirms a stable completion candidate and remains idempotent on replay', () => {
  let now = 0;
  const engine = createSessionLifecycleEngine({ stabilizationMs: 100, clock: () => now });
  engine.ingest(base('TURN_STARTED', 10, 'start'));
  engine.ingest(base('TURN_COMPLETED_SIGNAL', 20, 'complete'));
  assert.equal(engine.getState().publicState, 'COMPLETION_CANDIDATE');
  assert.equal(engine.advance(119).changed, false);
  now = 120;
  assert.equal(engine.advance().state.publicState, 'COMPLETED');
  const replay = engine.ingest(base('TURN_COMPLETED_SIGNAL', 20, 'complete'));
  assert.equal(replay.changed, false);
  assert.equal(engine.getState().publicState, 'COMPLETED');
});

test('runtime store isolates sessions and exposes only public snapshots', () => {
  // 固定时钟：老化阈值是 staleMs，若不固定时钟，ts=20 相对真实 Date.now() 早已过期而被降级。
  let now = 20;
  const store = createRuntimeStore({ stabilizationMs: 0, staleMs: 30 * 60 * 1000, clock: () => now });
  store.ingest('codex:a', { ...base('TURN_FAILED', 10, 'a-fail'), sessionRef: 'codex:a' });
  store.ingest('codex:b', { ...base('TURN_STARTED', 20, 'b-start'), sessionRef: 'codex:b' });
  assert.equal(store.snapshot('codex:a').publicState, 'FAILED');
  assert.equal(store.snapshot('codex:b').publicState, 'ACTIVE');
  assert.equal(store.snapshot('codex:a').seenEventIds, undefined);
  // 老化窗口过后同一会话降级为 IDLE（非 live），但保留原始证据
  now = 20 + 30 * 60 * 1000;
  assert.equal(store.snapshot('codex:b').publicState, 'IDLE');
  assert.equal(store.snapshot('codex:b').stale, true);
  assert.equal(store.snapshot('codex:a').publicState, 'FAILED'); // 终态永不老化
});

// 回归：无事件驱动的会话不会自己老化，ACTIVE/COMPLETION_CANDIDATE 会被永久保留，
// 曾导致 390 小时前的会话仍显示「进行中」。读取时必须按 staleMs 降级为 IDLE（非 live）。
test('aged ACTIVE / COMPLETION_CANDIDATE degrades to IDLE after staleMs', () => {
  const engine = createSessionLifecycleEngine({ stabilizationMs: 0, staleMs: 1000, clock: () => 100 });
  engine.ingest(base('TURN_STARTED', 100, 'start'));
  assert.equal(engine.getState(100).publicState, 'ACTIVE');
  assert.equal(engine.getState(1099).publicState, 'ACTIVE'); // 未到期仍是 active
  assert.equal(engine.getState(1100).publicState, 'IDLE'); // 到期降级
  assert.equal(engine.getState(1100).stale, true);

  const candidate = createSessionLifecycleEngine({ stabilizationMs: 60000, staleMs: 1000, clock: () => 100 });
  candidate.ingest(base('TURN_COMPLETED_SIGNAL', 100, 'done'));
  assert.equal(candidate.getState(100).publicState, 'COMPLETION_CANDIDATE');
  assert.equal(candidate.getState(5000).publicState, 'IDLE');
});

test('aging never rewrites terminal states or the internal state', () => {
  const engine = createSessionLifecycleEngine({ staleMs: 1000, clock: () => 0 });
  engine.ingest(base('TURN_FAILED', 10, 'fail'));
  assert.equal(engine.getState(999999).publicState, 'FAILED'); // 终态不受老化影响
  const active = createSessionLifecycleEngine({ staleMs: 1000, clock: () => 100 });
  active.ingest(base('TURN_STARTED', 100, 's'));
  assert.equal(active.getState(999999).publicState, 'IDLE');
  // 内部状态保留原始证据，便于诊断与后续事件推进
  assert.equal(active.getInternalState().publicState, 'ACTIVE');
});
