'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const hermes = require('./hermes');

test('parses Hermes state rows into stored-session events', () => {
  const events = hermes.parseSessionRows(
    {
      id: '20260824_071530_a1b2c3d4',
      title: 'TaskHub 跳转测试',
      cwd: 'C:\\workspace\\demo',
      profile_name: 'default',
    },
    [
      { id: 10, role: 'user', content: '打开这个项目', timestamp: 1787571000.25 },
      { id: 11, role: 'tool', content: '{"ok":true}', timestamp: 1787571000.5 },
      { id: 12, role: 'assistant', content: '好的', timestamp: 1787571001 },
    ]
  );

  assert.deepEqual(events, [
    {
      agent: 'hermes',
      sourceId: 'title:20260824_071530_a1b2c3d4',
      sessionId: '20260824_071530_a1b2c3d4',
      ts: 0,
      role: 'system',
      kind: 'title',
      text: '',
      title: 'TaskHub 跳转测试',
      project: 'C:\\workspace\\demo',
    },
    {
      agent: 'hermes',
      sourceId: '10',
      sessionId: '20260824_071530_a1b2c3d4',
      ts: 1787571000250,
      role: 'user',
      kind: 'message',
      text: '打开这个项目',
      project: 'C:\\workspace\\demo',
    },
    {
      agent: 'hermes',
      sourceId: '12',
      sessionId: '20260824_071530_a1b2c3d4',
      ts: 1787571001000,
      role: 'assistant',
      kind: 'message',
      text: '好的',
      project: 'C:\\workspace\\demo',
    },
  ]);
});

test('skips rows without a real timestamp instead of using current time', () => {
  const events = hermes.parseSessionRows(
    { id: 'session-1', title: '', cwd: '' },
    [
      { id: 1, role: 'user', content: '缺少时间', timestamp: null },
      { id: 2, role: 'assistant', content: '无效时间', timestamp: 'not-a-date' },
    ]
  );

  assert.deepEqual(events, []);
});

test('emits a turn_end event after a completed assistant response', () => {
  const events = hermes.parseSessionRows(
    { id: 'session-2', title: '', cwd: '' },
    [
      { id: 20, role: 'user', content: '查一下天气', timestamp: 1787572000 },
      { id: 21, role: 'assistant', content: '已经查到了', finish_reason: 'stop', timestamp: 1787572001 },
    ]
  );

  assert.deepEqual(events.at(-1), {
    agent: 'hermes',
    sourceId: '21:turnend',
    sessionId: 'session-2',
    ts: 1787572001000,
    kind: 'turn_end',
    project: '',
  });
});

test('emits a turn_end event from a terminal Hermes session row', () => {
  const events = hermes.parseSessionStatus(
    {
      id: 'session-3',
      cwd: 'C:\\workspace\\demo',
      ended_at: 1787573002,
      end_reason: 'ws_orphan_reap',
    },
    { timestamp: 1787573001 },
  );

  assert.deepEqual(events, [{
    agent: 'hermes',
    sourceId: 'session-end:session-3:1787573002000',
    sessionId: 'session-3',
    ts: 1787573002000,
    kind: 'turn_end',
    project: 'C:\\workspace\\demo',
  }]);
});

test('does not re-close a Hermes session after a newer message', () => {
  assert.deepEqual(
    hermes.parseSessionStatus(
      { id: 'session-4', ended_at: 1787573002, last_activity_at: 1787573002 },
      { timestamp: 1787573003 },
    ),
    [],
  );
});
