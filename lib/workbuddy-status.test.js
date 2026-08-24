'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const {
  normalizeSessionStatus,
  createStatusReader,
} = require('./workbuddy-status');
const workbuddy = require('./adapters/workbuddy');

test('WorkBuddy completed status is normalized as terminal with the newest timestamp', () => {
  assert.deepEqual(normalizeSessionStatus({
    id: 'session-1',
    status: 'completed',
    updated_at: 100,
    last_activity_at: 120,
    deleted_at: null,
  }), {
    sessionId: 'session-1',
    status: 'completed',
    statusAt: 120,
    terminal: true,
    active: false,
  });
});

test('WorkBuddy active status is recognized without treating unknown status as active', () => {
  assert.equal(normalizeSessionStatus({ id: 'running', status: 'running' }).active, true);
  assert.equal(normalizeSessionStatus({ id: 'working', status: 'working' }).active, true);
  assert.equal(normalizeSessionStatus({ id: 'future', status: 'paused' }).active, false);
  assert.equal(normalizeSessionStatus({ id: 'future', status: 'paused' }).terminal, false);
});

test('read-only status reader returns session rows from workbuddy.db', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-workbuddy-status-'));
  const dbPath = path.join(dir, 'workbuddy.db');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE sessions (id TEXT, status TEXT, updated_at INTEGER, last_activity_at INTEGER, deleted_at INTEGER)');
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?)').run('session-1', 'completed', 100, 120, null);
  db.close();

  const reader = createStatusReader({ dbPath });
  assert.deepEqual(reader.read().get('session-1'), {
    sessionId: 'session-1',
    status: 'completed',
    statusAt: 120,
    terminal: true,
    active: false,
  });
  reader.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('status reader degrades to an empty result when workbuddy.db is unavailable', () => {
  const reader = createStatusReader({ dbPath: path.join(os.tmpdir(), 'agent-board-missing-workbuddy.db') });
  assert.deepEqual(reader.read(), new Map());
  reader.close();
});

test('WorkBuddy adapter forwards database statuses using the stable agent reference', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-workbuddy-status-scan-'));
  const dbPath = path.join(dir, 'workbuddy.db');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE sessions (id TEXT, status TEXT, updated_at INTEGER, last_activity_at INTEGER, deleted_at INTEGER)');
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?)').run('session-1', 'completed', 100, 120, null);
  db.close();

  const reader = createStatusReader({ dbPath });
  const seen = [];
  workbuddy.scanSessionStatuses({ noteExternalStatus(ref, status) { seen.push({ ref, status }); } }, reader);
  reader.close();
  fs.rmSync(dir, { recursive: true, force: true });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].ref, 'workbuddy:session-1');
  assert.equal(seen[0].status.terminal, true);
});
