'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { zstdCompressSync } = require('node:zlib');
const test = require('node:test');
const deepseek = require('./deepseek');

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
