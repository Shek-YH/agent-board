'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const codex = require('./adapters/codex');

test('Codex task_complete 先进入基于真实连续工作间隔的 60 秒观察期', () => {
  const events = codex.parseLines([
    { timestamp: '2026-08-23T03:03:31.000Z', type: 'event_msg', payload: { type: 'task_complete' } },
  ], path.join('C:', 'sessions', 'rollout-2026-08-23T22-03-07-demo.jsonl'));

  assert.deepEqual(events, [{
    agent: 'codex',
    sourceId: '2026-08-23T22-03-07-demo:1787454211000:turnend',
    sessionId: '2026-08-23T22-03-07-demo',
    ts: 1787454211000,
    kind: 'turn_end',
    completionHoldMs: 60 * 1000,
  }]);
});
