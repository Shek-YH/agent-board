'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  DAY_MS,
  classifyActivity,
  isFullScanDue,
  createScanScheduler,
} = require('./scan-scheduler');

test('活跃度使用 session last_seen 与文件 mtime 的较新值', () => {
  const now = Date.parse('2026-09-05T12:00:00Z');
  assert.equal(classifyActivity({
    lastSeen: now - 2 * DAY_MS,
    fileMtime: now - 2 * 60 * 60 * 1000,
    now,
  }), 'hot');
  assert.equal(classifyActivity({
    lastSeen: now - 40 * DAY_MS,
    fileMtime: now - 3 * DAY_MS,
    now,
  }), 'warm');
  assert.equal(classifyActivity({ lastSeen: 0, fileMtime: 0, now }), 'cold');
});

test('分层边界和全量扫描到期判断稳定', () => {
  const now = Date.now();
  assert.equal(classifyActivity({ lastSeen: now - 24 * 60 * 60 * 1000, fileMtime: 0, now }), 'hot');
  assert.equal(classifyActivity({ lastSeen: now - 7 * 24 * 60 * 60 * 1000 - 1, fileMtime: 0, now }), 'recent');
  assert.equal(classifyActivity({ lastSeen: now - 30 * 24 * 60 * 60 * 1000 - 1, fileMtime: 0, now }), 'cold');
  assert.equal(isFullScanDue(now - 6 * 60 * 60 * 1000, now), true);
  assert.equal(isFullScanDue(now - 6 * 60 * 60 * 1000 + 1, now), false);
});

test('扫描请求单飞，手动全量请求会合并到当前扫描之后', async () => {
  const runs = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const scheduler = createScanScheduler({
    run: async (request) => {
      runs.push(request.kind);
      if (request.kind === 'startup-recent') await gate;
    },
    readLastFullScanAt: () => Date.now(),
  });
  const first = scheduler.request('startup-recent');
  scheduler.request('manual-full');
  scheduler.request('scheduled-full');
  assert.deepEqual(runs, ['startup-recent']);
  release();
  await first;
  await scheduler.whenIdle();
  assert.deepEqual(runs, ['startup-recent', 'manual-full']);
  scheduler.stop();
});

function fakeClock(startAt = 0) {
  let current = startAt;
  let nextId = 0;
  const timers = new Map();
  return {
    now: () => current,
    setTimeout(fn, delay) {
      const id = ++nextId;
      timers.set(id, { id, dueAt: current + delay, fn });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    async advance(ms) {
      current += ms;
      while (true) {
        const due = [...timers.values()]
          .filter((timer) => timer.dueAt <= current)
          .sort((left, right) => left.dueAt - right.dueAt || left.id - right.id);
        if (!due.length) break;
        for (const timer of due) {
          if (!timers.has(timer.id)) continue;
          timers.delete(timer.id);
          timer.fn();
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
    },
  };
}

test('自动全量扫描按启动宽限和成功时间重新计算下一周期', async () => {
  const clock = fakeClock(1000);
  const runs = [];
  const fullTimes = [];
  const scheduler = createScanScheduler({
    run: async (request) => { runs.push(request.kind); },
    readLastFullScanAt: () => fullTimes.at(-1) || 0,
    writeLastFullScanAt: (timestamp) => fullTimes.push(timestamp),
    now: clock.now,
    setTimeoutFn: clock.setTimeout,
    clearTimeoutFn: clock.clearTimeout,
    warmIntervalMs: 100,
    fullIntervalMs: 20,
    startupFullGraceMs: 5,
  });
  scheduler.start();
  await clock.advance(4);
  assert.deepEqual(runs, []);
  await clock.advance(1);
  await scheduler.whenIdle();
  assert.deepEqual(runs, ['scheduled-full']);
  assert.deepEqual(fullTimes, [1005]);
  await clock.advance(19);
  assert.deepEqual(runs, ['scheduled-full']);
  await clock.advance(1);
  await scheduler.whenIdle();
  assert.deepEqual(runs, ['scheduled-full', 'scheduled-full']);
  scheduler.stop();
});

test('自动全量扫描失败后等待完整周期，不进行紧密重试', async () => {
  const clock = fakeClock(2000);
  const runs = [];
  const scheduler = createScanScheduler({
    run: async (request) => {
      runs.push(request.kind);
      throw new Error('temporary scan failure');
    },
    readLastFullScanAt: () => 0,
    now: clock.now,
    setTimeoutFn: clock.setTimeout,
    clearTimeoutFn: clock.clearTimeout,
    warmIntervalMs: 1000,
    fullIntervalMs: 20,
    startupFullGraceMs: 5,
  });
  scheduler.start();
  await clock.advance(5);
  await scheduler.whenIdle();
  assert.deepEqual(runs, ['scheduled-full']);
  await clock.advance(19);
  assert.deepEqual(runs, ['scheduled-full']);
  await clock.advance(1);
  await scheduler.whenIdle();
  assert.deepEqual(runs, ['scheduled-full', 'scheduled-full']);
  scheduler.stop();
});
