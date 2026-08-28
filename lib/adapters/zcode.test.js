'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const test = require('node:test');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ZCODE_ADAPTER = path.join(REPO_ROOT, 'lib', 'adapters', 'zcode.js');

function createDb(dbPath, includeStop) {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      title TEXT,
      directory TEXT,
      task_type TEXT
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      time_created INTEGER,
      data TEXT,
      sequence INTEGER
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT,
      session_id TEXT,
      time_created INTEGER,
      data TEXT,
      sequence INTEGER
    );
  `);
  db.prepare('INSERT INTO session (id, title, directory, task_type) VALUES (?, ?, ?, ?)')
    .run('sess-1', 'test session', 'C:\\project', 'interactive');
  db.prepare('INSERT INTO message (id, session_id, time_created, data, sequence) VALUES (?, ?, ?, ?, ?)')
    .run('msg-1', 'sess-1', 100, JSON.stringify({ role: 'user' }), 0);
  db.prepare('INSERT INTO part (id, message_id, session_id, time_created, data, sequence) VALUES (?, ?, ?, ?, ?, ?)')
    .run('part-text', 'msg-1', 'sess-1', 110, JSON.stringify({ type: 'text', text: 'hello' }), 0);
  db.prepare('INSERT INTO part (id, message_id, session_id, time_created, data, sequence) VALUES (?, ?, ?, ?, ?, ?)')
    .run('part-tools', 'msg-1', 'sess-1', 200, JSON.stringify({ type: 'step-finish', reason: 'tool-calls' }), 4);
  if (includeStop) {
    db.prepare('INSERT INTO part (id, message_id, session_id, time_created, data, sequence) VALUES (?, ?, ?, ?, ?, ?)')
      .run('part-stop', 'msg-1', 'sess-1', 300, JSON.stringify({ type: 'step-finish', reason: 'stop' }), 3);
  }
  db.close();
}

function runScenario({ includeStop, appendStop, initialPartOffset }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-zcode-offset-'));
  const home = path.join(root, 'home');
  const dbDir = path.join(home, '.zcode', 'cli', 'db');
  const dbPath = path.join(dbDir, 'db.sqlite');
  fs.mkdirSync(dbDir, { recursive: true });
  createDb(dbPath, includeStop);

  const script = `
    const { DatabaseSync } = require('node:sqlite');
    const zcode = require(${JSON.stringify(ZCODE_ADAPTER)});
    const dbPath = ${JSON.stringify(dbPath)};
    const meta = new Map(${JSON.stringify(initialPartOffset == null ? [] : [['offset:zcode:part:sess-1', String(initialPartOffset)]])});
    const events = [];
    const store = {
      stmts: {
        getMeta: { get: (key) => meta.has(key) ? { v: meta.get(key) } : undefined },
        setMeta: { run: (key, value) => meta.set(key, String(value)) },
      },
      ingest: (event) => events.push(event),
    };
    const first = zcode.scanAll(store);
    ${appendStop ? `
      const writer = new DatabaseSync(dbPath);
      writer.prepare('INSERT INTO part (id, message_id, session_id, time_created, data, sequence) VALUES (?, ?, ?, ?, ?, ?)')
        .run('part-stop', 'msg-1', 'sess-1', 300, JSON.stringify({ type: 'step-finish', reason: 'stop' }), 3);
      writer.close();
    ` : ''}
    const second = ${appendStop ? 'zcode.scanAll(store)' : 'null'};
    console.log(JSON.stringify({ first, second, events, partOffset: meta.get('offset:zcode:part:sess-1') }));
  `;
  try {
    const result = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      env: { ...process.env, USERPROFILE: home, HOME: home },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout.trim());
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('ZCode 增量扫描不能因 part.sequence 非全局递增而漏掉后到的 stop 信号', () => {
  const result = runScenario({ includeStop: false, appendStop: true });
  const turnEnds = result.events.filter((event) => event.kind === 'turn_end');

  assert.equal(turnEnds.length, 1);
  assert.equal(turnEnds[0].sourceId, 'turnend:part-stop');
  assert.equal(result.partOffset, '300');
});

test('ZCode 切换到时间游标后应能自愈已有的旧 sequence 游标', () => {
  const result = runScenario({ includeStop: true, appendStop: false, initialPartOffset: 4 });
  const turnEnds = result.events.filter((event) => event.kind === 'turn_end');

  assert.equal(turnEnds.length, 1);
  assert.equal(turnEnds[0].sourceId, 'turnend:part-stop');
  assert.equal(result.partOffset, '300');
});
