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

test('Marvis 近期扫描按 conversation.updated_at 过滤旧会话', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-marvis-cutoff-'));
  const home = path.join(root, 'home');
  const dbPath = path.join(home, 'AppData', 'Roaming', 'Tencent', 'Marvis', 'User', 'user-1', 'database', 'data.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  createDb(dbPath);
  const writer = new DatabaseSync(dbPath);
  writer.prepare('INSERT INTO conversations VALUES (?, ?, ?, ?, ?, ?)')
    .run('conv-2', 'recent title', 'in_progress', '{}', '2026-09-04T00:00:00Z', '2026-09-04T00:01:00Z');
  writer.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('msg-recent', 'conv-2', 0, 'user', 'recent', null, '2026-09-04T00:01:01Z');
  writer.close();
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
    marvis.scanAll(store, { cutoff: Date.parse('2026-09-01T00:00:00Z') });
    console.log(JSON.stringify(events.filter((event) => event.kind === 'message').map((event) => event.sessionId)));
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
    assert.deepEqual(JSON.parse(result.stdout.trim()), ['conv-2']);
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

// 完成事件出口闭环：conversations.status 终态 → kind:'turn_end' → store.setDoneSignal →
// 稳定窗后广播。adapter 需要保证 turn_end 排在消息【之后】入库，否则 store 会把同一扫描中
// 10 分钟内的残余消息当作「复活」撤销完成候选（lib/store.js ingest 取消点），终态永不广播。
test('Marvis 终态主会话的 turn_end 排在消息之后；cancelled 状态不当作完成广播', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-marvis-order-'));
  const home = path.join(root, 'home');
  const dbPath = path.join(home, 'AppData', 'Roaming', 'Tencent', 'Marvis', 'User', 'user-1', 'database', 'data.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE conversations (
      conversation_id TEXT PRIMARY KEY, title TEXT, status TEXT, metadata TEXT,
      created_at TEXT, updated_at TEXT
    );
    CREATE TABLE messages (
      message_id TEXT PRIMARY KEY, conversation_id TEXT, message_seq INTEGER,
      role TEXT, content TEXT, metadata TEXT, created_at TEXT
    );
  `);
  const now = Date.now();
  const iso = (t) => new Date(t).toISOString();
  const insC = db.prepare('INSERT INTO conversations VALUES (?, ?, ?, ?, ?, ?)');
  const insM = db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?)');
  insC.run('conv-done', '完成的任务', 'completed', '{}', iso(now - 120000), iso(now - 1000));
  insM.run('m-done-1', 'conv-done', 0, 'user', '帮我写周报', null, iso(now - 110000));
  insM.run('m-done-2', 'conv-done', 1, 'assistant', '已完成', null, iso(now - 1000));
  insC.run('conv-cancel', '被取消的任务', 'cancelled', '{}', iso(now - 60000), iso(now - 2000));
  insM.run('m-can-1', 'conv-cancel', 0, 'user', '跑一半取消', null, iso(now - 50000));
  insM.run('m-can-2', 'conv-cancel', 1, 'assistant', '部分结果', null, iso(now - 2000));
  db.close();
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
    marvis.scanAll(store);
    console.log(JSON.stringify(events));
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
    const events = JSON.parse(result.stdout.trim());
    // 主会话事件顺序：所有真实消息之后才是 turn_end（完成候选才不会被残余消息撤销）
    const convEvents = events.filter((event) => event.sessionId === 'conv-done');
    assert.ok(convEvents.length >= 2, 'conv-done 应有消息与 turn_end');
    assert.equal(convEvents.at(-1).kind, 'turn_end');
    assert.equal(convEvents.at(-1).ts, Date.parse(iso(now - 1000)));
    // 完成会话不带 turnStatus（广播），取消会话带 cancelled（store 据此抑制弹窗）
    const doneEnd = events.find((event) => event.kind === 'turn_end' && event.sessionId === 'conv-done');
    assert.equal(doneEnd.turnStatus, undefined);
    const cancelEnd = events.find((event) => event.kind === 'turn_end' && event.sessionId === 'conv-cancel');
    assert.equal(cancelEnd.turnStatus, 'cancelled');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// 端到端闭环：真实 store（隔离 AB_DATA_DIR）+ marvis adapter。completed 主会话经
// 通用完成出口广播一次；cancelled 主会话与 subagent child 均不广播。
test('Marvis completed 主会话经通用完成出口广播，cancelled 与 child 不广播', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-marvis-loop-'));
  const dbPath = path.join(root, 'Marvis', 'User', 'user-1', 'database', 'data.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE conversations (
      conversation_id TEXT PRIMARY KEY, title TEXT, status TEXT, metadata TEXT,
      created_at TEXT, updated_at TEXT
    );
    CREATE TABLE messages (
      message_id TEXT PRIMARY KEY, conversation_id TEXT, message_seq INTEGER,
      role TEXT, content TEXT, metadata TEXT, created_at TEXT
    );
  `);
  const now = Date.now();
  const iso = (t) => new Date(t).toISOString();
  const insC = db.prepare('INSERT INTO conversations VALUES (?, ?, ?, ?, ?, ?)');
  const insM = db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?)');
  insC.run('conv-loop', '闭环任务', 'completed', '{}', iso(now - 120000), iso(now - 1000));
  insM.run('m-l-1', 'conv-loop', 0, 'user', '开始', null, iso(now - 110000));
  insM.run('m-l-2', 'conv-loop', 1, 'assistant', '主回复', null, iso(now - 1000));
  insM.run('m-l-3', 'conv-loop', 2, 'assistant', '子代理回复', JSON.stringify({ subagent: { id: 'sa-loop', name: '子代理' } }), iso(now - 2000));
  insC.run('conv-loop-cancel', '被取消', 'cancelled', '{}', iso(now - 60000), iso(now - 3000));
  insM.run('m-lc-1', 'conv-loop-cancel', 0, 'user', '取消', null, iso(now - 50000));
  insM.run('m-lc-2', 'conv-loop-cancel', 1, 'assistant', '部分', null, iso(now - 3000));
  db.close();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-marvis-loop-data-'));
  const script = `
    const store = require(${JSON.stringify(path.join(__dirname, '..', 'store.js'))});
    const marvis = require(${JSON.stringify(MARVIS_ADAPTER)});
    const received = [];
    store.setCompletionStabilizeMs('marvis', 25);
    store.onAgentCompletion((ev) => received.push(ev));
    marvis.scanAll(store);
    setTimeout(() => { console.log('RESULT=' + JSON.stringify(received)); process.exit(0); }, 150);
  `;
  try {
    const result = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      env: { ...process.env, AB_DATA_DIR: dataDir, AGENT_BOARD_MARVIS_SOURCE_PATH: path.join(root, 'Marvis', 'User') },
      timeout: 30000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const line = result.stdout.split('\n').find((l) => l.startsWith('RESULT='));
    assert.ok(line, '缺少 RESULT 输出: ' + result.stdout);
    const received = JSON.parse(line.slice('RESULT='.length));
    assert.deepEqual(received.map((ev) => [ev.provider, ev.sessionId]), [['marvis', 'conv-loop']]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
