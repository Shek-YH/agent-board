'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');

const SESSION_ID = 'delivery-session';
const TARGET = { agent: 'hermes', sessionRef: `hermes:${SESSION_ID}`, project: 'C:/repo' };
const SENT_AT = 1788000000000;

function fixtureDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-hermes-delivery-'));
  const dbPath = path.join(dir, 'state.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT, cwd TEXT);
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT,
      timestamp REAL, finish_reason TEXT
    );
    INSERT INTO sessions (id, title, cwd) VALUES ('${SESSION_ID}', 'Delivery', 'C:/repo');
    INSERT INTO sessions (id, title, cwd) VALUES ('other-session', 'Other', 'C:/other');
  `);
  db.prepare('INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)')
    .run(1, SESSION_ID, 'user', 'old', 1787999999);
  db.close();
  return { dir, dbPath };
}

test('Hermes delivery snapshot accepts only a new matching user message', () => {
  const { captureHermesDeliverySnapshot, verifyHermesDelivery } = require('./hermes-delivery');
  const fixture = fixtureDb();
  try {
    const snapshot = captureHermesDeliverySnapshot(TARGET, { dbPath: fixture.dbPath, now: SENT_AT - 1000 });
    const db = new DatabaseSync(fixture.dbPath);
    db.prepare('INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)')
      .run(2, SESSION_ID, 'assistant', 'assistant echo', 1788000001);
    db.prepare('INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)')
      .run(3, SESSION_ID, 'user', ' hello\r\nworld ', 1788000001);
    db.close();
    const result = verifyHermesDelivery(TARGET, 'hello\nworld', { snapshot, sentAt: SENT_AT });
    assert.equal(result.ok, true);
    assert.equal(result.delivered, true);
    assert.equal(result.sessionRef, TARGET.sessionRef);
    assert.equal(result.messageId, 3);
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('Hermes delivery ignores old, assistant, and other-session rows', () => {
  const { captureHermesDeliverySnapshot, verifyHermesDelivery } = require('./hermes-delivery');
  const fixture = fixtureDb();
  try {
    const snapshot = captureHermesDeliverySnapshot(TARGET, { dbPath: fixture.dbPath, now: SENT_AT - 1000 });
    const db = new DatabaseSync(fixture.dbPath);
    db.prepare('INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)')
      .run(2, 'other-session', 'user', 'hello', 1788000001);
    db.prepare('INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)')
      .run(3, SESSION_ID, 'assistant', 'hello', 1788000001);
    db.close();
    const result = verifyHermesDelivery(TARGET, 'hello', { snapshot, sentAt: SENT_AT });
    assert.equal(result.ok, false);
    assert.equal(result.delivered, false);
    assert.equal(result.code, 'DELIVERY_NOT_FOUND');
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('Hermes delivery returns unknown on database/schema failure', () => {
  const { captureHermesDeliverySnapshot, verifyHermesDelivery } = require('./hermes-delivery');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-hermes-delivery-bad-'));
  const dbPath = path.join(dir, 'state.db');
  fs.writeFileSync(dbPath, 'not a sqlite database');
  try {
    const snapshot = { agent: 'hermes', dbPath, sessionId: SESSION_ID, lastMessageId: 0, capturedAt: SENT_AT - 1000 };
    const result = verifyHermesDelivery(TARGET, 'hello', { snapshot, sentAt: SENT_AT });
    assert.equal(result.ok, false);
    assert.equal(result.unknown, true);
    assert.equal(result.code, 'DELIVERY_UNKNOWN');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Hermes delivery reader exposes snapshot and verify functions for orchestration injection', () => {
  const { createHermesDeliveryReader } = require('./hermes-delivery');
  const reader = createHermesDeliveryReader({ dbPath: 'fixture.db' });
  assert.equal(typeof reader.snapshot, 'function');
  assert.equal(typeof reader.verify, 'function');
  assert.equal(typeof reader.verifyFingerprint, 'function');
});

test('Hermes delivery can reconcile after a crash using only the instruction fingerprint', () => {
  const { captureHermesDeliverySnapshot, verifyHermesDeliveryFingerprint } = require('./hermes-delivery');
  const fixture = fixtureDb();
  try {
    const snapshot = captureHermesDeliverySnapshot(TARGET, { dbPath: fixture.dbPath, now: SENT_AT - 1000 });
    const db = new DatabaseSync(fixture.dbPath);
    db.prepare('INSERT INTO messages (id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)')
      .run(2, SESSION_ID, 'user', 'hello\r\nworld', 1788000001);
    db.close();
    const fingerprint = crypto.createHash('sha256').update('hello\nworld', 'utf8').digest('hex');
    const result = verifyHermesDeliveryFingerprint(TARGET, fingerprint, { snapshot, sentAt: SENT_AT });
    assert.equal(result.ok, true);
    assert.equal(result.delivered, true);
    assert.equal(result.fingerprintVerified, true);
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});
