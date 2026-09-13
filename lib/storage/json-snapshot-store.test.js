'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createJsonSnapshotStore } = require('./json-snapshot-store');

test('JSON snapshot adapter backs up before atomic save and loads the snapshot', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-storage-'));
  const filePath = path.join(root, 'data.json');
  fs.writeFileSync(filePath, JSON.stringify({ sessions: [{ id: 'old' }] }), 'utf8');
  const store = createJsonSnapshotStore({ filePath, backupDir: path.join(root, 'backups') });
  const saved = store.save({ sessions: [{ id: 'new' }], messages: [] });
  assert.equal(saved.backup.created, true);
  assert.deepEqual(store.load(), { sessions: [{ id: 'new' }], messages: [] });
  assert.equal(fs.readdirSync(path.join(root, 'backups')).length, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test('JSON snapshot adapter refuses to overwrite a corrupt file during load', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-storage-'));
  const filePath = path.join(root, 'data.json');
  fs.writeFileSync(filePath, '{broken', 'utf8');
  const store = createJsonSnapshotStore({ filePath, backupDir: path.join(root, 'backups') });
  assert.throws(() => store.load(), /invalid JSON snapshot/);
  assert.equal(fs.readFileSync(filePath, 'utf8'), '{broken');
  fs.rmSync(root, { recursive: true, force: true });
});

test('JSON snapshot adapter supports asynchronous atomic save without a per-save migration backup', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-storage-'));
  const filePath = path.join(root, 'data.json');
  fs.writeFileSync(filePath, JSON.stringify({ version: 1 }), 'utf8');
  const backupDir = path.join(root, 'backups');
  const store = createJsonSnapshotStore({ filePath, backupDir });
  await store.saveAsync({ version: 2 }, { backup: false });
  assert.deepEqual(store.load(), { version: 2 });
  assert.equal(fs.existsSync(backupDir), false);
  fs.rmSync(root, { recursive: true, force: true });
});
