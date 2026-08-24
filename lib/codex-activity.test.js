'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const codex = require('./adapters/codex');

const source = fs.readFileSync(path.join(__dirname, 'adapters', 'codex.js'), 'utf8');

test('单任务单回合的 Codex task_complete 只进入 5 秒短观察期', () => {
  const events = codex.parseLines([
    { timestamp: '2026-08-23T03:03:31.000Z', type: 'event_msg', payload: { type: 'task_complete' } },
  ], path.join('C:', 'sessions', 'rollout-2026-08-23T22-03-07-demo.jsonl'));

  assert.deepEqual(events, [{
    agent: 'codex',
    sourceId: '2026-08-23T22-03-07-demo:1787454211000:turnend',
    sessionId: '2026-08-23T22-03-07-demo',
    ts: 1787454211000,
    kind: 'turn_end',
    completionHoldMs: 5 * 1000,
  }]);
  assert.equal(codex.completionHoldMsForHistory([
    { type: 'event_msg', payload: { type: 'task_started' }, ts: 0 },
    { type: 'event_msg', payload: { type: 'task_complete' }, ts: 1000 },
    { type: 'event_msg', payload: { type: 'task_started' }, ts: 55000 },
  ], 1000), 5 * 1000);
});

test('多回合 session 使用已观察到的短接续间隔加 6 秒缓冲并封顶 60 秒', () => {
  const events = [
    { type: 'event_msg', payload: { type: 'task_started' }, ts: 0 },
    { type: 'event_msg', payload: { type: 'task_complete' }, ts: 1000 },
    { type: 'event_msg', payload: { type: 'task_started' }, ts: 55000 },
    { type: 'event_msg', payload: { type: 'task_complete' }, ts: 60000 },
    { type: 'event_msg', payload: { type: 'task_started' }, ts: 214000 },
    { type: 'event_msg', payload: { type: 'task_complete' }, ts: 300000 },
  ];
  assert.equal(codex.completionHoldMsForHistory(events, 300000), 60 * 1000);
});

test('只有 task_started 或真实用户消息才确认新回合', () => {
  assert.equal(codex.isDefinitiveContinuationLine({ type: 'event_msg', payload: { type: 'task_started' } }), true);
  assert.equal(codex.isDefinitiveContinuationLine({
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '继续执行' }] },
  }), true);
  assert.equal(codex.isDefinitiveContinuationLine({
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<recommended_plugins>系统注入</recommended_plugins>' }] },
  }), false);
  assert.equal(codex.isDefinitiveContinuationLine({ type: 'event_msg', payload: { type: 'token_count' } }), false);
});

test('多回合但没有短接续记录时使用 10 秒观察期', () => {
  const events = [
    { type: 'event_msg', payload: { type: 'task_started' }, ts: 0 },
    { type: 'event_msg', payload: { type: 'task_complete' }, ts: 1000 },
    { type: 'event_msg', payload: { type: 'task_started' }, ts: 301000 },
    { type: 'event_msg', payload: { type: 'task_complete' }, ts: 302000 },
  ];
  assert.equal(codex.completionHoldMsForHistory(events, 302000), 10 * 1000);
});

test('重启对账按当前活跃会话而非文件修改时间筛选', () => {
  assert.match(source, /const activeRefs = new Set\(store\.getActive\(\)/);
  assert.match(source, /if \(!activeRefs\.has\(`\$\{ID\}:\$\{sessionIdFromPath\(f\)\}`\)\) continue;/);
});
