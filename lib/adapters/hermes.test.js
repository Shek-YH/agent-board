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
      sessionRole: 'main',
      rootSessionId: '20260824_071530_a1b2c3d4',
      topologySource: 'structural',
      topologyConfidence: 1,
      childDetection: 'verified',
      controlEligibility: 'eligible',
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
      sessionRole: 'main',
      rootSessionId: '20260824_071530_a1b2c3d4',
      topologySource: 'structural',
      topologyConfidence: 1,
      childDetection: 'verified',
      controlEligibility: 'eligible',
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
      sessionRole: 'main',
      rootSessionId: '20260824_071530_a1b2c3d4',
      topologySource: 'structural',
      topologyConfidence: 1,
      childDetection: 'verified',
      controlEligibility: 'eligible',
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
    sessionRole: 'main',
    rootSessionId: 'session-2',
    topologySource: 'structural',
    topologyConfidence: 1,
    childDetection: 'verified',
    controlEligibility: 'eligible',
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
    sessionRole: 'main',
    rootSessionId: 'session-3',
    topologySource: 'structural',
    topologyConfidence: 1,
    childDetection: 'verified',
    controlEligibility: 'eligible',
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

test('projects a matched delegate_task result into a stable blocked child span', () => {
  const events = hermes.parseSessionRows(
    { id: 'parent-1', title: 'Parent', cwd: 'C:\\workspace\\demo' },
    [
      {
        id: 30, role: 'assistant', timestamp: 1787573000, finish_reason: 'tool_calls',
        tool_calls: JSON.stringify([{ id: 'call-1', function: {
          name: 'delegate_task', arguments: JSON.stringify({ goal: 'Inspect files', role: 'explorer' }),
        } }]),
      },
      {
        id: 31, role: 'tool', timestamp: 1787573001,
        tool_name: 'delegate_task', tool_call_id: 'call-1',
        content: JSON.stringify({ results: [{ task_index: 0, status: 'completed', summary: 'Done' }] }),
      },
    ],
  );

  const childId = 'parent-1:subagent:call-1:0';
  const childEvents = events.filter((event) => event.sessionId === childId);
  assert.equal(childEvents[0].kind, 'title');
  assert.equal(childEvents[0].title, 'Inspect files');
  assert.equal(childEvents[1].role, 'user');
  assert.equal(childEvents[1].text, 'Inspect files');
  assert.equal(childEvents[2].role, 'assistant');
  assert.equal(childEvents[2].text, 'Done');
  assert.equal(childEvents[3].kind, 'turn_end');
  for (const event of childEvents) {
    assert.equal(event.sessionRole, 'child');
    assert.equal(event.parentSessionId, 'parent-1');
    assert.equal(event.rootSessionId, 'parent-1');
    assert.equal(event.topologySource, 'explicit');
    assert.equal(event.childDetection, 'verified');
    assert.equal(event.controlEligibility, 'blocked');
  }
  assert.notEqual(childEvents[1].sourceId, '30');
});

test('projects each batched delegate_task item by index and ignores unmatched results', () => {
  const events = hermes.parseSessionRows(
    { id: 'parent-batch', cwd: '' },
    [
      {
        id: 40, role: 'assistant', timestamp: 1787574000, finish_reason: 'tool_calls',
        tool_calls: JSON.stringify([{ id: 'call-batch', function: {
          name: 'delegate_task', arguments: JSON.stringify({ tasks: [
            { goal: 'One' }, { goal: 'Two', role: 'reviewer' },
          ] }),
        } }]),
      },
      {
        id: 41, role: 'tool', timestamp: 1787574001, tool_name: 'delegate_task', tool_call_id: 'wrong-call',
        content: JSON.stringify({ results: [{ task_index: 0, status: 'completed', summary: 'Wrong' }] }),
      },
      {
        id: 42, role: 'tool', timestamp: 1787574002, tool_name: 'delegate_task', tool_call_id: 'call-batch',
        content: JSON.stringify({ results: [
          { task_index: 1, status: 'success', summary: 'Second done' },
          { task_index: 8, status: 'completed', summary: 'Unknown' },
        ] }),
      },
    ],
  );

  const first = events.filter((event) => event.sessionId === 'parent-batch:subagent:call-batch:0');
  const second = events.filter((event) => event.sessionId === 'parent-batch:subagent:call-batch:1');
  assert.equal(first.filter((event) => event.kind === 'message').length, 1);
  assert.equal(second.find((event) => event.role === 'assistant').text, 'Second done');
  assert.equal(second.at(-1).kind, 'turn_end');
  assert.equal(events.some((event) => event.text === 'Wrong' || event.text === 'Unknown'), false);
});

test('requires exact delegate_task evidence and tolerates malformed payloads', () => {
  const events = hermes.parseSessionRows(
    { id: 'parent-safe', parent_session_id: 'compression-parent' },
    [
      { id: 50, role: 'assistant', timestamp: 1787575000, finish_reason: 'tool_calls',
        tool_calls: JSON.stringify([{ id: 'not-delegate', function: {
          name: 'delegate_task_status', arguments: JSON.stringify({ goal: 'Not a child' }),
        } }]) },
      { id: 51, role: 'tool', timestamp: 1787575001, tool_name: 'delegate_task_status', tool_call_id: 'not-delegate',
        content: JSON.stringify({ results: [{ task_index: 0, status: 'completed', summary: 'Nope' }] }) },
      { id: 52, role: 'assistant', timestamp: 1787575002, finish_reason: 'tool_calls', tool_calls: '{malformed' },
      { id: 53, role: 'tool', timestamp: 1787575003, tool_name: 'delegate_task', tool_call_id: 'missing', content: '{malformed' },
    ],
  );

  assert.equal(events.some((event) => event.sessionRole === 'child'), false);
  assert.equal(events.every((event) => event.sessionId === 'parent-safe'), true);
  assert.equal(events.find((event) => event.kind === 'title')?.sessionRole, undefined);
});

test('ordinary Hermes rows remain main even when parent_session_id is present', () => {
  const events = hermes.parseSessionRows(
    { id: 'ordinary', parent_session_id: 'compression-lineage' },
    [{ id: 60, role: 'user', content: 'continue', timestamp: 1787576000 }],
  );
  assert.equal(events[0].sessionId, 'ordinary');
  assert.equal(events[0].sessionRole, 'main');
  assert.equal(events[0].childDetection, 'verified');
  assert.equal(events[0].controlEligibility, 'eligible');
});

test('Hermes replay cursor uses topology-v2', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, 'hermes.js'), 'utf8');
  assert.match(source, /offset:topology-v2:\$\{ID\}:\$\{sid\}/);
});
