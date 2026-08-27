'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { collectFiles, snapshotTree, diffSnapshots, shouldResetOffset } = require('./watcher');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-watcher-'));
}

test('snapshotTree 和 diffSnapshots 能发现新增、修改和删除文件', () => {
  const root = tempDir();
  const file = path.join(root, 'session.jsonl');
  const added = path.join(root, 'nested', 'new.jsonl');
  fs.writeFileSync(file, '{"role":"user"}\n', 'utf8');

  const before = snapshotTree(root, (item) => item.endsWith('.jsonl'));
  fs.mkdirSync(path.dirname(added), { recursive: true });
  fs.writeFileSync(file, '{"role":"user","text":"changed"}\n', 'utf8');
  fs.writeFileSync(added, '{"role":"assistant"}\n', 'utf8');
  fs.unlinkSync(file);
  const after = snapshotTree(root, (item) => item.endsWith('.jsonl'));

  const diff = diffSnapshots(before, after);
  assert.deepEqual(diff.deleted, [file]);
  assert.deepEqual(diff.changed.sort(), [added]);
  assert.deepEqual(collectFiles(root, (item) => item.endsWith('.jsonl')), [added]);
});

test('shouldResetOffset 只在文件被替换或截断时重置，普通追加不重置', () => {
  assert.equal(shouldResetOffset({ identity: 'same', size: 10 }, { identity: 'same', size: 20 }), false);
  assert.equal(shouldResetOffset({ identity: 'old', size: 10 }, { identity: 'new', size: 20 }), true);
  assert.equal(shouldResetOffset({ identity: 'same', size: 20 }, { identity: 'same', size: 10 }), true);
});
