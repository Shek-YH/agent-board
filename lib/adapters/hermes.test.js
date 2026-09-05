'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
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

test('declares Hermes routing as prompt-only until model control is verified', () => {
  const capability = hermes.createRoutingCapability();
  assert.deepEqual(capability, { name: 'hermes', supportsReasoning: false, routingMode: 'prompt-only' });
  assert.equal(Object.isFrozen(capability), true);
});

test('resolves a delegate_task result against calls from a previous poll', () => {
  const start = {
    id: 70, role: 'assistant', timestamp: 1787577000, finish_reason: 'tool_calls',
    tool_calls: JSON.stringify([{ id: 'call-across-polls', function: {
      name: 'delegate_task', arguments: JSON.stringify({ goal: 'Historical call' }),
    } }]),
  };
  const finish = {
    id: 71, role: 'tool', timestamp: 1787577001,
    tool_name: 'delegate_task', tool_call_id: 'call-across-polls',
    content: JSON.stringify({ results: [{ task_index: 0, status: 'completed', summary: 'Historical result' }] }),
  };

  const events = hermes.parseSessionRows({ id: 'parent-poll' }, [finish], [start]);
  const childEvents = events.filter((event) => event.sessionId === 'parent-poll:subagent:call-across-polls:0');
  assert.equal(childEvents.length, 2);
  assert.equal(childEvents[0].text, 'Historical result');
  assert.equal(childEvents[1].kind, 'turn_end');
  assert.equal(hermes.parseSessionRows({ id: 'parent-poll' }, [finish]).length, 0);
});

test('ingestSession loads historical delegate calls as parse context', () => {
  const source = fs.readFileSync(path.join(__dirname, 'hermes.js'), 'utf8');
  assert.match(source, /expression\('role'\)[\s\S]*expression\('tool_calls'\)[\s\S]*IS NOT NULL/);
  assert.match(source, /parseSessionRows\(sessionForRows, rows, contextRows/);
});

function tempHermesDb(schema, rows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-hermes-schema-'));
  const dbPath = path.join(dir, 'state.db');
  const db = new DatabaseSync(dbPath);
  db.exec(schema);
  for (const row of rows) {
    const columns = Object.keys(row);
    const values = columns.map((column) => row[column]);
    db.prepare(`INSERT INTO messages (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(...values);
  }
  db.close();
  return { dbPath, dir };
}

function testStore() {
  const meta = new Map();
  return {
    events: [],
    stmts: {
      getMeta: { get: (key) => meta.has(key) ? { v: meta.get(key) } : undefined },
      setMeta: { run: (key, value) => meta.set(key, String(value)) },
    },
    ingest(event) { this.events.push(event); },
  };
}

test('scans an old Hermes messages schema without delegation columns', () => {
  const fixture = tempHermesDb(
    `CREATE TABLE sessions (
       id TEXT PRIMARY KEY, title TEXT, cwd TEXT, profile_name TEXT,
       ended_at REAL, end_reason TEXT, last_activity_at REAL, started_at REAL
     );
     CREATE TABLE messages (
       id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT,
       timestamp REAL, finish_reason TEXT
     );
     INSERT INTO sessions (id, title, cwd, ended_at, started_at)
       VALUES ('old-session', 'Old', 'C:/old', 1787578001, 1787578000);`,
    [{ id: 1, session_id: 'old-session', role: 'user', content: 'old message', timestamp: 1787578000, finish_reason: null }],
  );
  const store = testStore();
  try {
    hermes.scanDb(fixture.dbPath, store);
    assert.equal(store.events.some((event) => event.sessionId === 'old-session' && event.role === 'user'), true);
    assert.equal(store.events.some((event) => event.sessionRole === 'child'), false);
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('Hermes 近期扫描按 Session 活动时间过滤旧会话', () => {
  const oldStarted = Math.floor(Date.parse('2026-08-28T00:00:00Z') / 1000);
  const recentStarted = Math.floor(Date.parse('2026-09-04T00:00:00Z') / 1000);
  const fixture = tempHermesDb(
    `CREATE TABLE sessions (
       id TEXT PRIMARY KEY, title TEXT, cwd TEXT, profile_name TEXT,
       ended_at REAL, end_reason TEXT, last_activity_at REAL, started_at REAL
     );
     CREATE TABLE messages (
       id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT,
       timestamp REAL, finish_reason TEXT
     );
     INSERT INTO sessions (id, title, cwd, started_at)
       VALUES ('old-session', 'Old', 'C:/old', ${oldStarted});
     INSERT INTO sessions (id, title, cwd, started_at)
       VALUES ('recent-session', 'Recent', 'C:/recent', ${recentStarted});`,
    [
      { id: 1, session_id: 'old-session', role: 'user', content: 'old message', timestamp: oldStarted, finish_reason: null },
      { id: 2, session_id: 'recent-session', role: 'user', content: 'recent message', timestamp: recentStarted, finish_reason: null },
    ],
  );
  const store = testStore();
  try {
    hermes.scanDb(fixture.dbPath, store, { cutoff: Date.parse('2026-09-01T00:00:00Z') });
    const messageSessions = store.events.filter((event) => event.kind === 'message').map((event) => event.sessionId);
    assert.deepEqual(messageSessions, ['recent-session']);
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('scans a current Hermes schema and projects delegation rows', () => {
  const fixture = tempHermesDb(
    `CREATE TABLE sessions (
       id TEXT PRIMARY KEY, title TEXT, cwd TEXT, profile_name TEXT,
       ended_at REAL, end_reason TEXT, last_activity_at REAL, started_at REAL
     );
     CREATE TABLE messages (
       id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT,
       tool_call_id TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL, finish_reason TEXT
     );
     INSERT INTO sessions (id, title, cwd, started_at)
       VALUES ('new-session', 'New', 'C:/new', 1787578000);`,
    [
      { id: 1, session_id: 'new-session', role: 'assistant', content: '', tool_calls: JSON.stringify([{ id: 'call-db', function: { name: 'delegate_task', arguments: JSON.stringify({ goal: 'DB child' }) } }]), timestamp: 1787578000, finish_reason: 'tool_calls' },
      { id: 2, session_id: 'new-session', role: 'tool', content: JSON.stringify({ results: [{ task_index: 0, status: 'completed', summary: 'DB done' }] }), tool_name: 'delegate_task', tool_call_id: 'call-db', timestamp: 1787578001 },
    ],
  );
  const store = testStore();
  try {
    hermes.scanDb(fixture.dbPath, store);
    assert.equal(store.events.some((event) => event.sessionId === 'new-session:subagent:call-db:0' && event.text === 'DB done'), true);
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('scans persisted delegate child sessions with native completion status', () => {
  const fixture = tempHermesDb(
    `CREATE TABLE sessions (
       id TEXT PRIMARY KEY, title TEXT, cwd TEXT, profile_name TEXT,
       parent_session_id TEXT, model_config TEXT,
       ended_at REAL, end_reason TEXT, last_activity_at REAL, started_at REAL
     );
     CREATE TABLE messages (
       id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT,
       timestamp REAL, finish_reason TEXT
     );
     INSERT INTO sessions (id, title, cwd, started_at)
       VALUES ('parent-native', 'Parent', 'C:/native', 1787578000);
     INSERT INTO sessions (id, title, cwd, parent_session_id, model_config, ended_at, end_reason, started_at)
       VALUES ('child-native', NULL, 'C:/native', 'parent-native',
         '{"_delegate_from":"parent-native"}', 1787578002, 'agent_close', 1787578001);`,
    [
      { id: 1, session_id: 'parent-native', role: 'user', content: 'delegate', timestamp: 1787578000 },
      { id: 2, session_id: 'child-native', role: 'user', content: 'child goal', timestamp: 1787578001 },
      { id: 3, session_id: 'child-native', role: 'assistant', content: 'child result', timestamp: 1787578002, finish_reason: 'stop' },
    ],
  );
  const store = testStore();
  try {
    hermes.scanDb(fixture.dbPath, store);
    const child = store.events.filter((event) => event.sessionId === 'child-native');
    assert.equal(child.some((event) => event.sessionRole === 'child'), true);
    assert.equal(child.some((event) => event.role === 'assistant' && event.text === 'child result'), true);
    assert.equal(child.some((event) => event.kind === 'turn_end'), true);
    assert.equal(child.every((event) => event.parentSessionId === 'parent-native'), true);
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('native Hermes child scan retires stale synthetic child projections', () => {
  const fixture = tempHermesDb(
    `CREATE TABLE sessions (
       id TEXT PRIMARY KEY, title TEXT, cwd TEXT, profile_name TEXT,
       parent_session_id TEXT, model_config TEXT,
       ended_at REAL, end_reason TEXT, last_activity_at REAL, started_at REAL
     );
     CREATE TABLE messages (
       id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT,
       tool_call_id TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL, finish_reason TEXT
     );
     INSERT INTO sessions (id, title, cwd, started_at)
       VALUES ('parent-native-cleanup', 'Parent', 'C:/native', 1787578000);
     INSERT INTO sessions (id, title, cwd, parent_session_id, model_config, ended_at, end_reason, started_at)
       VALUES ('child-native-cleanup', NULL, 'C:/native', 'parent-native-cleanup',
         '{"_delegate_from":"parent-native-cleanup"}', 1787578002, 'agent_close', 1787578001);`,
    [
      {
        id: 1, session_id: 'parent-native-cleanup', role: 'assistant', timestamp: 1787578000,
        finish_reason: 'tool_calls',
        tool_calls: JSON.stringify([{ id: 'call-cleanup', function: {
          name: 'delegate_task', arguments: JSON.stringify({ goal: 'Native child' }),
        } }]),
      },
      { id: 2, session_id: 'child-native-cleanup', role: 'user', content: 'Native child', timestamp: 1787578001 },
    ],
  );
  const store = testStore();
  const deleted = [];
  store.deleteSessionByRef = (agent, sessionId) => deleted.push(`${agent}:${sessionId}`);
  try {
    hermes.scanDb(fixture.dbPath, store);
    assert.deepEqual(deleted, ['hermes:parent-native-cleanup:subagent:call-cleanup:0']);
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('projects Hermes async delegation batch completion into child turn ends', () => {
  const events = hermes.parseSessionRows(
    { id: 'parent-async', cwd: '' },
    [
      {
        id: 90, role: 'assistant', timestamp: 1787579000, finish_reason: 'tool_calls',
        tool_calls: JSON.stringify([{ id: 'call-async', function: {
          name: 'delegate_task', arguments: JSON.stringify({ tasks: [
            { goal: 'A task' }, { goal: 'B task' },
          ] }),
        } }]),
      },
      {
        id: 91, role: 'tool', timestamp: 1787579001, tool_name: 'delegate_task', tool_call_id: 'call-async',
        content: JSON.stringify({ status: 'dispatched', delegation_id: 'deleg-1', count: 2 }),
      },
      {
        id: 92, role: 'user', timestamp: 1787579002,
        content: '[ASYNC DELEGATION BATCH COMPLETE — deleg-1]\n'
          + '--- ✓ TASK 1/2: A task (status=completed, api_calls=1) ---\n'
          + 'A result\nFull live transcript: task-0.log\n'
          + '--- ✓ TASK 2/2: B task (status=failed, api_calls=1) ---\n'
          + 'B failed\nFull live transcript: task-1.log',
      },
    ],
  );
  const child = events.filter((event) => event.sessionId === 'parent-async:subagent:call-async:0');
  assert.equal(child.some((event) => event.role === 'assistant' && event.text === 'A result'), true);
  assert.equal(child.some((event) => event.kind === 'turn_end'), true);
  const failed = events.filter((event) => event.sessionId === 'parent-async:subagent:call-async:1');
  assert.equal(failed.some((event) => event.role === 'assistant' && event.text === 'B failed'), true);
  assert.equal(failed.some((event) => event.kind === 'turn_end'), true);
});

test('does not coerce object call metadata into a child identity', () => {
  const events = hermes.parseSessionRows({ id: 'strict' }, [{
    id: 80, role: 'assistant', timestamp: 1787579000, finish_reason: 'tool_calls',
    tool_calls: [{ id: { bad: true }, function: { name: 'delegate_task', arguments: { goal: { bad: true }, role: { bad: true } } } }],
  }]);
  assert.equal(events.some((event) => event.sessionRole === 'child'), false);
});
