'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { listUserDbs } = require('./marvis');

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
