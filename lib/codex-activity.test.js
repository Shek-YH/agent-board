'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const codex = require('./adapters/codex');

test('Codex task_complete 仅表示一轮响应结束，不结束整个会话', () => {
  const events = codex.parseLines([
    { timestamp: '2026-08-23T03:03:31.000Z', type: 'event_msg', payload: { type: 'task_complete' } },
  ], path.join('C:', 'sessions', 'rollout-2026-08-23T22-03-07-demo.jsonl'));

  assert.deepEqual(events, []);
});
