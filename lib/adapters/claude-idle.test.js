'use strict';
// claude.checkDesktopIdle 依赖的末行判定 getLastTurnMeta + fileToSessionId 缓存（纯逻辑单测；
// checkDesktopIdle 主循环与 workbuddy/deepseek 同款，由 test-idle-check.js 的真实目录脚本覆盖）。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const claude = require('./claude');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-claude-idle-'));

test.after(() => {
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

function writeSession(file, lines) {
  fs.writeFileSync(path.join(DIR, file), lines.join('\n') + '\n', 'utf8');
}

test('getLastTurnMeta：末行 assistant + stop_reason=end_turn → 可判停（settled）', () => {
  const f = path.join(DIR, 's1.jsonl');
  writeSession('s1.jsonl', [
    JSON.stringify({ type: 'user', sessionId: 's1', timestamp: '2026-01-01T00:00:00Z', message: { content: [{ type: 'text', text: 'hi' }] } }),
    JSON.stringify({ type: 'assistant', sessionId: 's1', timestamp: '2026-01-01T00:01:00Z', message: { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' } }),
  ]);
  const meta = claude.getLastTurnMeta(f);
  assert.equal(meta.type, 'assistant');
  assert.equal(meta.stopReason, 'end_turn');
});

test('getLastTurnMeta：末行 assistant + stop_reason=tool_use → 工具循环中，不判停', () => {
  const f = path.join(DIR, 's2.jsonl');
  writeSession('s2.jsonl', [
    JSON.stringify({ type: 'user', sessionId: 's2', timestamp: '2026-01-01T00:00:00Z', message: { content: [{ type: 'text', text: 'go' }] } }),
    JSON.stringify({ type: 'assistant', sessionId: 's2', timestamp: '2026-01-01T00:00:05Z', message: { content: [{ type: 'tool_use', name: 'Bash' }], stop_reason: 'tool_use' } }),
  ]);
  const meta = claude.getLastTurnMeta(f);
  assert.equal(meta.stopReason, 'tool_use');
});

test('getLastTurnMeta：末行 user（等回复）/空文件/损坏行 → 不判停', () => {
  const fUser = path.join(DIR, 's3.jsonl');
  writeSession('s3.jsonl', [JSON.stringify({ type: 'user', sessionId: 's3', timestamp: '2026-01-01T00:00:00Z', message: { content: [{ type: 'text', text: 'q' }] } })]);
  assert.equal(claude.getLastTurnMeta(fUser).type, 'user');

  const fEmpty = path.join(DIR, 's4.jsonl');
  fs.writeFileSync(fEmpty, '', 'utf8');
  assert.equal(claude.getLastTurnMeta(fEmpty), null);

  const fBad = path.join(DIR, 's5.jsonl');
  fs.writeFileSync(fBad, '{broken\n', 'utf8');
  assert.equal(claude.getLastTurnMeta(fBad), null);
});

test('fileToSessionId：parseLines 写入的 sessionId 缓存优先于文件名', () => {
  // s6.jsonl 文件名是 uuid，但行内 sessionId 才是看板 ref 的真实来源
  writeSession('s6.jsonl', [
    JSON.stringify({ type: 'user', sessionId: 'real-session-6', timestamp: '2026-01-01T00:00:00Z', message: { content: [{ type: 'text', text: 'hi' }] } }),
  ]);
  claude.parseLines(['{"type":"user","sessionId":"real-session-6","timestamp":"2026-01-01T00:00:00Z","message":{"content":[{"type":"text","text":"hi"}]}}'], path.join(DIR, 's6.jsonl'));
  assert.equal(claude.fileToSessionId(path.join(DIR, 's6.jsonl')), 'real-session-6');
});
