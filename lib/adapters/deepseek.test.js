'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { zstdCompressSync } = require('node:zlib');
const test = require('node:test');

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
