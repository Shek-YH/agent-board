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
});

function createDb(dbPath) {
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
    .run('conv-1', 'parent title', 'in_progress', '{}', '2026-08-28T00:00:00Z', '2026-08-28T00:01:00Z');
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
    console.log(JSON.stringify({ count, events, keys: [...meta.keys()] }));
  `;
  try {
    const result = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      env: { ...process.env, USERPROFILE: home, HOME: home },
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
    assert.ok(output.keys.includes('offset:topology-v2:marvis:conv-1'));
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
