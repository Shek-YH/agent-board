'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { zstdCompressSync } = require('node:zlib');
const test = require('node:test');
const deepseek = require('./deepseek');
// 真实 store（含通用完成出口与"已广播后无新活动不再登记"守卫）。store-fixture 先设
// AB_DATA_DIR 到临时目录再 require store，避免污染真实 AgentBoard 数据。
const store = require('../../test-support/store-fixture');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('DeepSeek topology distinguishes native child sessions from main sessions', () => {
  const child = deepseek.parseLines([
    {
      type: 'session', id: 'child-1', cwd: 'C:\\project', origin: 'subagent',
      parentSession: 'parent-1', delegationDepth: 1,
    },
    {
      type: 'assistant/message', seq: 1, time: 1000,
      data: { message: { content: [{ type: 'text', text: 'done' }] } },
    },
  ]).find((event) => event.kind === 'message');
  assert.equal(child.sessionRole, 'child');
  assert.equal(child.parentSessionId, 'parent-1');
  assert.equal(child.rootSessionId, 'parent-1');
  assert.equal(child.childDetection, 'verified');
  assert.equal(child.controlEligibility, 'blocked');

  const main = deepseek.parseLines([
    { type: 'session', id: 'main-1', cwd: 'C:\\project' },
    { type: 'user/message', seq: 1, time: 1000, data: { source: { kind: 'user' }, content: 'hello' } },
  ]).find((event) => event.kind === 'message');
  assert.equal(main.sessionRole, 'main');
  assert.equal(main.childDetection, 'verified');
  assert.equal(main.controlEligibility, 'eligible');
});

test('DeepSeek parentSession and delegationDepth alone stay main sessions', () => {
  const fork = deepseek.parseLines([
    { type: 'session', id: 'fork-1', parentSession: 'parent-1' },
    { type: 'assistant/message', seq: 1, time: 1000, data: { message: { content: 'fork' } } },
  ]).find((event) => event.kind === 'message');
  assert.equal(fork.sessionRole, 'main');
  assert.equal(fork.controlEligibility, 'eligible');

  const delegated = deepseek.parseLines([
    { type: 'session', id: 'delegated-1', delegationDepth: 1 },
    { type: 'assistant/message', seq: 1, time: 1000, data: { message: { content: 'depth' } } },
  ]).find((event) => event.kind === 'message');
  assert.equal(delegated.sessionRole, 'main');
  assert.equal(delegated.controlEligibility, 'eligible');
});

test('DeepSeek descriptor is child evidence only when parentSession is present', () => {
  const child = deepseek.parseLines([
    { type: 'session', id: 'child-descriptor', parentSession: 'parent-2' },
    { type: 'subagent/descriptor', data: { mode: 'explorer', provider: 'deepseek' } },
    { type: 'assistant/message', seq: 1, time: 1000, data: { message: { content: 'done' } } },
  ]).find((event) => event.kind === 'message');
  assert.equal(child.sessionRole, 'child');
  assert.equal(child.parentSessionId, 'parent-2');
  assert.equal(child.topologySource, 'explicit');
  assert.equal(child.controlEligibility, 'blocked');

  const descriptorWithoutParent = deepseek.parseLines([
    { type: 'session', id: 'descriptor-only' },
    { type: 'subagent/descriptor', data: { mode: 'explorer', provider: 'deepseek' } },
    { type: 'assistant/message', seq: 1, time: 1000, data: { message: { content: 'main' } } },
  ]).find((event) => event.kind === 'message');
  assert.equal(descriptorWithoutParent.sessionRole, 'main');
  assert.equal(descriptorWithoutParent.parentSessionId, undefined);
  assert.equal(descriptorWithoutParent.controlEligibility, 'eligible');

  const originWithoutParent = deepseek.parseLines([
    { type: 'session', id: 'origin-only', origin: 'subagent' },
    { type: 'assistant/message', seq: 1, time: 1000, data: { message: { content: 'main' } } },
  ]).find((event) => event.kind === 'message');
  assert.equal(originWithoutParent.sessionRole, 'main');
  assert.equal(originWithoutParent.controlEligibility, 'eligible');
});

test('DeepSeek topology propagates to title; turn/end 不产出回合终态事件', () => {
  const events = deepseek.parseLines([
    { type: 'session', id: 'child-events', origin: 'subagent', parentSession: 'parent-events' },
    { type: 'session/title', data: { title: 'Child task', source: { kind: 'provider' } } },
    { type: 'turn/end', seq: 2, time: 1001, data: { reason: { kind: 'completed' } } },
  ]);
  const turnEnd = events.find((event) => event.kind === 'turn_end');
  const title = events.find((event) => event.kind === 'title');
  // DSH 的 turn/end 只是「回合结束」，不是会话终态：不得产出 turn_end 完成信号，
  // 否则正在运行的会话会在最近一轮结束后被误标为「已完成」。
  assert.equal(turnEnd, undefined);
  assert.equal(title.sessionRole, 'child');
  assert.equal(title.parentSessionId, 'parent-events');
});

test('DeepSeek mtime replay cache uses topology-v3', () => {
  const source = fs.readFileSync(path.join(__dirname, 'deepseek.js'), 'utf8');
  assert.match(source, /mtime:v3/);
});

test('DeepSeek tailRead 使用 Node 内置 zstd 解压，不依赖 Python', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-deepseek-'));
  const file = path.join(dir, 'session.jsonl.zstd');
  const source = [
    JSON.stringify({ type: 'session', id: 'session-test', cwd: 'D:\\work' }),
    JSON.stringify({ type: 'message', id: 'msg-1', role: 'user', content: 'hello' }),
    '',
  ].join('\n');
  fs.writeFileSync(file, zstdCompressSync(Buffer.from(source, 'utf8')));

  const script = [
    "const deepseek = require(process.argv[1]);",
    "const result = deepseek.tailRead(process.argv[2], 0);",
    "process.stdout.write(JSON.stringify(result.lines));",
  ].join('\n');
  const result = spawnSync(process.execPath, ['-e', script, path.join(__dirname, 'deepseek.js'), file], {
    env: { ...process.env, AGENTBOARD_PYTHON: path.join(dir, 'missing-python.exe') },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const lines = JSON.parse(result.stdout);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].id, 'session-test');
  assert.equal(lines[1].content, 'hello');
});

test('DeepSeek tailRead 能读取整体重写产生的连续 zstd 帧', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-deepseek-frames-'));
  const file = path.join(dir, 'session.jsonl.zstd');
  const first = JSON.stringify({ type: 'session', id: 'session-frames' }) + '\n';
  const second = [
    JSON.stringify({ type: 'user/message', seq: 1, data: { source: { kind: 'user' }, content: 'hello' } }),
    JSON.stringify({ type: 'assistant/message', seq: 2, data: { message: { content: [{ type: 'text', text: 'world' }] } } }),
    '',
  ].join('\n');
  fs.writeFileSync(file, Buffer.concat([
    zstdCompressSync(Buffer.from(first, 'utf8')),
    zstdCompressSync(Buffer.from(second, 'utf8')),
  ]));

  const deepseek = require('./deepseek');
  const result = deepseek.tailRead(file, 0);
  assert.equal(result.lines.length, 3);
  assert.equal(result.lines[0].type, 'session');
  assert.equal(result.lines[1].type, 'user/message');
  assert.equal(result.lines[2].type, 'assistant/message');
});

// 停顿判停的完成事件去重回归：checkDesktopIdle 每 ~20s tick 都会对静止会话再调一次
// store.setAgentActive(ref, false, Date.now())（ts 递增）。store 通用完成出口须保证
// 「同一次停顿」只广播一次——已广播过该会话且自上次广播后无新活动证据时不再登记候选。
test('DeepSeek 静止会话在重复停顿 tick 下只广播一次完成事件', async () => {
  store.clearAll();
  store.setCompletionStabilizeMs('deepseek', 5); // 把 4000ms 稳定窗缩到 5ms 便于测试
  const received = [];
  const off = store.onAgentCompletion((ev) => received.push(ev));
  try {
    const sessionId = 'ds-stop-dedupe';
    const ref = `deepseek:${sessionId}`;
    store.ingest({
      agent: 'deepseek', sourceId: 'seed-stop-1', sessionId,
      ts: Date.now(), role: 'assistant', kind: 'message', text: 'done',
    });
    const base = Date.now() + 1000; // 让停顿时刻晚于最后一条真实消息，避免活体否决
    for (let i = 0; i < 3; i++) {
      // 模拟 checkDesktopIdle 三个 20s tick 的重复判停（ts 单调递增，绕过 ref@ts 去重）
      store.setAgentActive(ref, false, base + i * 20000);
      await wait(40);
    }
    assert.equal(received.length, 1);
    assert.equal(received[0].provider, 'deepseek');
    assert.equal(received[0].sessionId, sessionId);
  } finally {
    off();
  }
});

// resume 后可再广播：新真实消息（lastMsgAt 晚于上次广播时刻）恢复活跃，再次停顿属于
// 新一轮完成，应允许第二次广播。
test('DeepSeek 会话 resume（新消息）后再次停顿可再广播完成事件', async () => {
  store.clearAll();
  store.setCompletionStabilizeMs('deepseek', 5);
  const received = [];
  const off = store.onAgentCompletion((ev) => received.push(ev));
  try {
    const sessionId = 'ds-stop-resume';
    const base = Date.now();
    store.ingest({
      agent: 'deepseek', sourceId: 'seed-resume-1', sessionId,
      ts: base + 100, role: 'assistant', kind: 'message', text: 'round1',
    });
    // 第一轮停顿 → 广播 #1
    store.setAgentActive(`deepseek:${sessionId}`, false, base + 20000);
    await wait(40);
    assert.equal(received.length, 1);
    // resume：晚于上次广播的新真实消息 + 恢复活跃（新消息会清 agentStopAt 并撤销候选）
    store.ingest({
      agent: 'deepseek', sourceId: 'resume-msg-1', sessionId,
      ts: base + 60000, role: 'user', kind: 'message', text: '继续',
    });
    store.setAgentActive(`deepseek:${sessionId}`, true, base + 61000);
    await wait(20);
    // 第二轮停顿 → 允许新一轮广播
    store.setAgentActive(`deepseek:${sessionId}`, false, base + 80000);
    await wait(40);
    assert.equal(received.length, 2);
    assert.equal(received[1].sessionId, sessionId);
    assert.ok(received[1].completedAt >= base + 80000);
  } finally {
    off();
  }
});
