'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const test = require('node:test');

const MARVIS_ADAPTER = path.join(__dirname, 'marvis.js');
const { listUserDbs, topologyForMessage } = require('./marvis');

test('Marvis 只根据 metadata.subagent.id 识别子代理', () => {
  const child = topologyForMessage('conv-1', JSON.stringify({
    subagent: { id: 'sa-1', name: 'File Agent' },
  }));
  assert.deepEqual(child, {
    sessionId: 'conv-1:subagent:sa-1',
    sessionRole: 'child',
    parentSessionId: 'conv-1',
    rootSessionId: 'conv-1',
    topologySource: 'explicit',
    topologyConfidence: 1,
    childDetection: 'verified',
    controlEligibility: 'blocked',
    title: 'File Agent',
  });

  const main = topologyForMessage('conv-1', '{malformed');
  assert.equal(main.sessionId, 'conv-1');
  assert.equal(main.sessionRole, 'main');
  assert.equal(main.parentSessionId, undefined);
  assert.equal(main.childDetection, 'verified');
  assert.equal(main.controlEligibility, 'eligible');

  const objectMetadata = topologyForMessage('conv-1', {
    subagent: { id: 'sa-object' },
  });
  assert.equal(objectMetadata.sessionId, 'conv-1:subagent:sa-object');
  assert.equal(objectMetadata.title, '子代理 sa-object');
});

function createDb(dbPath, status = 'in_progress') {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE conversations (
      conversation_id TEXT PRIMARY KEY,
      title TEXT,
      status TEXT,
      metadata TEXT,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE messages (
      message_id TEXT PRIMARY KEY,
      conversation_id TEXT,
      message_seq INTEGER,
      role TEXT,
      content TEXT,
      metadata TEXT,
      created_at TEXT
    );
  `);
  db.prepare('INSERT INTO conversations VALUES (?, ?, ?, ?, ?, ?)')
    .run('conv-1', 'parent title', status, '{}', '2026-08-28T00:00:00Z', '2026-08-28T00:01:00Z');
  const insert = db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?)');
  insert.run('msg-parent', 'conv-1', 0, 'user', 'parent', null, '2026-08-28T00:00:01Z');
  insert.run('msg-file-1', 'conv-1', 1, 'assistant', 'file result', JSON.stringify({
    subagent: { id: 'sa-file', name: 'File Agent' },
  }), '2026-08-28T00:00:02Z');
  insert.run('msg-search', 'conv-1', 2, 'assistant', 'search result', JSON.stringify({
    subagent: { id: 'sa-search', name: 'Search Agent' },
  }), '2026-08-28T00:00:03Z');
  insert.run('msg-file-2', 'conv-1', 3, 'assistant', 'more files', JSON.stringify({
    subagent: { id: 'sa-file', name: 'File Agent' },
  }), '2026-08-28T00:00:04Z');
  insert.run('msg-empty-child', 'conv-1', 4, 'assistant', '', JSON.stringify({
    subagent: { id: 'sa-empty' },
  }), '2026-08-28T00:00:05Z');
  db.close();
}

test('Marvis 扫描按 conversation + subagent.id 分组并使用 topology-v2 游标', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-marvis-topology-'));
  const home = path.join(root, 'home');
  const dbPath = path.join(home, 'AppData', 'Roaming', 'Tencent', 'Marvis', 'User', 'user-1', 'database', 'data.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  createDb(dbPath);
  const script = `
    const marvis = require(${JSON.stringify(MARVIS_ADAPTER)});
    const meta = new Map();
    const events = [];
    const store = {
      stmts: {
        getMeta: { get: (key) => meta.has(key) ? { v: meta.get(key) } : undefined },
        setMeta: { run: (key, value) => meta.set(key, String(value)) },
      },
      ingest: (event) => events.push(event),
    };
    const count = marvis.scanAll(store);
    console.log(JSON.stringify({ count, events, keys: [...meta.keys()], offset: meta.get('offset:topology-v2:marvis:conv-1') }));
  `;
  try {
    const result = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        USERPROFILE: home,
        HOME: home,
        APPDATA: path.join(home, 'AppData', 'Roaming'),
        LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout.trim());
    const messages = output.events.filter((event) => event.kind === 'message');
    assert.deepEqual(messages.map((event) => event.sessionId), [
      'conv-1',
      'conv-1:subagent:sa-file',
      'conv-1:subagent:sa-search',
      'conv-1:subagent:sa-file',
    ]);
    assert.equal(output.events.find((event) => event.kind === 'title' && event.sessionId === 'conv-1:subagent:sa-file').title, 'File Agent');
    assert.equal(output.events.find((event) => event.kind === 'message' && event.sessionId === 'conv-1:subagent:sa-search').controlEligibility, 'blocked');
    assert.equal(output.events.find((event) => event.kind === 'title' && event.sessionId === 'conv-1:subagent:sa-empty').title, '子代理 sa-empty');
    assert.equal(output.events.find((event) => event.kind === 'title' && event.sessionId === 'conv-1:subagent:sa-empty').controlEligibility, 'blocked');
    assert.ok(output.keys.includes('offset:topology-v2:marvis:conv-1'));
    assert.equal(output.offset, '4');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Marvis conversation 进入终态时应结束已枚举出的所有 child，即使 child 消息已超过增量游标', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-marvis-terminal-'));
  const home = path.join(root, 'home');
  const dbPath = path.join(home, 'AppData', 'Roaming', 'Tencent', 'Marvis', 'User', 'user-1', 'database', 'data.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  createDb(dbPath);
  const script = `
    const { DatabaseSync } = require('node:sqlite');
    const marvis = require(${JSON.stringify(MARVIS_ADAPTER)});
    const dbPath = ${JSON.stringify(dbPath)};
    const meta = new Map();
    const events = [];
    const store = {
      stmts: {
        getMeta: { get: (key) => meta.has(key) ? { v: meta.get(key) } : undefined },
        setMeta: { run: (key, value) => meta.set(key, String(value)) },
      },
      ingest: (event) => events.push(event),
    };
    marvis.scanAll(store);
    const writer = new DatabaseSync(dbPath);
    writer.prepare('UPDATE conversations SET status = ?, updated_at = ? WHERE conversation_id = ?')
      .run('completed', '2026-08-28T00:02:00Z', 'conv-1');
    writer.close();
    marvis.scanAll(store);
    console.log(JSON.stringify(events.filter((event) => event.kind === 'turn_end')));
  `;
  try {
    const result = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        USERPROFILE: home,
        HOME: home,
        APPDATA: path.join(home, 'AppData', 'Roaming'),
        LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const turnEnds = JSON.parse(result.stdout.trim());
    assert.deepEqual(turnEnds.map((event) => event.sessionId).sort(), [
      'conv-1',
      'conv-1:subagent:sa-empty',
      'conv-1:subagent:sa-file',
      'conv-1:subagent:sa-search',
    ].sort());
    for (const event of turnEnds) {
      assert.equal(event.childDetection, 'verified');
      assert.equal(event.topologyConfidence, 1);
      assert.equal(event.sessionId === 'conv-1' ? event.controlEligibility : event.controlEligibility, event.sessionId === 'conv-1' ? 'eligible' : 'blocked');
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Marvis 初始扫描应包含所有用户数据库，而不是只选最近修改的空库', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-marvis-users-'));
  const emptyDb = path.join(root, 'default_user', 'database', 'data.db');
  const realDb = path.join(root, 'user-with-sessions', 'database', 'data.db');
  fs.mkdirSync(path.dirname(emptyDb), { recursive: true });
  fs.mkdirSync(path.dirname(realDb), { recursive: true });
  fs.writeFileSync(emptyDb, 'empty');
  fs.writeFileSync(realDb, 'real');
  fs.utimesSync(emptyDb, new Date(2_000), new Date(2_000));
  fs.utimesSync(realDb, new Date(1_000), new Date(1_000));

  try {
    assert.deepEqual(listUserDbs(root), [emptyDb, realDb].sort());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
