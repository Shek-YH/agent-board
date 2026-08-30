'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createSpoolReader } = require('./workbuddy-spool');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-workbuddy-spool-'));
}

function cursorStore() {
  const meta = new Map();
  return {
    meta,
    stmts: {
      getMeta: { get(key) { return meta.has(key) ? { v: meta.get(key) } : undefined; } },
      setMeta: { run(key, value) { meta.set(key, value); } },
    },
  };
}

function line(event, ts, extra = {}) {
  return JSON.stringify({ schema_version: 1, event, ts, session_id: 'session-1', ...extra });
}

test('spool reader 按轮转文件到当前文件读取，并按游标只返回新增事件', () => {
  const dir = tempDir();
  const active = path.join(dir, 'events.spool');
  const rotated = `${active}.1`;
  const store = cursorStore();
  fs.writeFileSync(rotated, `${line('UserPromptSubmit', 100)}\n`, 'utf8');
  fs.writeFileSync(active, `${line('Stop', 120)}\n`, 'utf8');

  try {
    const reader = createSpoolReader({ spoolPaths: [active, rotated] });
    const first = reader.read(store);
    assert.deepEqual(first.events.map((event) => event.event), ['UserPromptSubmit', 'Stop']);
    assert.deepEqual(reader.read(store).events, []);

    fs.appendFileSync(active, `${line('UserPromptSubmit', 200)}\n`, 'utf8');
    assert.deepEqual(reader.read(store).events.map((event) => event.event), ['UserPromptSubmit']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('spool reader 检测轮转文件身份变化后从新文件头读取，不重复旧偏移', () => {
  const dir = tempDir();
  const active = path.join(dir, 'events.spool');
  const rotated = `${active}.1`;
  const store = cursorStore();
  fs.writeFileSync(active, `${line('Stop', 100)}\n`, 'utf8');

  try {
    const reader = createSpoolReader({ spoolPaths: [active, rotated] });
    assert.equal(reader.read(store).events.length, 1);
    fs.renameSync(active, rotated);
    fs.writeFileSync(active, `${line('UserPromptSubmit', 200)}\n`, 'utf8');
    const next = reader.read(store);
    assert.deepEqual(next.events.map((event) => event.event), ['UserPromptSubmit']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('spool reader 忽略重复 event_id，但不把不同 session 的事件混在一起', () => {
  const dir = tempDir();
  const active = path.join(dir, 'events.spool');
  const store = cursorStore();
  const duplicate = line('Stop', 100, { event_id: 'stop-1' });
  fs.writeFileSync(active, `${duplicate}\n${duplicate}\n${line('Stop', 100, { session_id: 'session-2', event_id: 'stop-2' })}\n`, 'utf8');

  try {
    const reader = createSpoolReader({ spoolPaths: [active] });
    const events = reader.read(store).events;
    assert.deepEqual(events.map((event) => event.event_id), ['stop-1', 'stop-2']);
    assert.deepEqual(events.map((event) => event.session_id), ['session-1', 'session-2']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('spool reader 检测同文件截断并从新头部恢复游标', () => {
  const dir = tempDir();
  const active = path.join(dir, 'events.spool');
  const store = cursorStore();
  fs.writeFileSync(active, `${line('UserPromptSubmit', 100)}\n${line('Stop', 110)}\n`, 'utf8');

  try {
    const reader = createSpoolReader({ spoolPaths: [active] });
    assert.equal(reader.read(store).events.length, 2);
    fs.writeFileSync(active, `${line('UserPromptSubmit', 200)}\n`, 'utf8');
    assert.deepEqual(reader.read(store).events.map((event) => event.ts), [200]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('多个候选 spool 按事件时间合并，避免两个路径改变状态的顺序不稳定', () => {
  const dir = tempDir();
  const first = path.join(dir, 'first.spool');
  const second = path.join(dir, 'second.spool');
  const store = cursorStore();
  fs.writeFileSync(first, `${line('Stop', 200)}\n`, 'utf8');
  fs.writeFileSync(second, `${line('UserPromptSubmit', 100)}\n`, 'utf8');

  try {
    const reader = createSpoolReader({ spoolPaths: [first, second] });
    assert.deepEqual(reader.read(store).events.map((event) => event.ts), [100, 200]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
