'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  collectFiles, snapshotTree, diffSnapshots, shouldResetOffset,
  tailRead, tailReadAsync, tailRecent,
} = require('./watcher');

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

test('tail reads use bounded ranges and preserve UTF-8 plus incomplete final lines', async () => {
  const root = tempDir();
  const file = path.join(root, 'session.jsonl');
  const first = '{"text":"你好"}\n';
  const second = '{"text":"第二行"}\n';
  const partial = '{"text":"未完成"';
  fs.writeFileSync(file, first + second + partial, 'utf8');
  const firstOffset = Buffer.byteLength(first, 'utf8');

  const originalReadFileSync = fs.readFileSync;
  fs.readFileSync = () => { throw new Error('whole-file sync read is forbidden'); };
  try {
    const sync = tailRead(file, firstOffset, 128);
    assert.deepEqual(sync.lines, [{ text: '第二行' }]);
    assert.equal(sync.newOffset, firstOffset + Buffer.byteLength(second, 'utf8'));
    assert.deepEqual(tailRecent(file, 128).lines, [{ text: '第二行' }]);
  } finally {
    fs.readFileSync = originalReadFileSync;
  }

  const originalReadFile = fs.promises.readFile;
  fs.promises.readFile = async () => { throw new Error('whole-file async read is forbidden'); };
  try {
    const asyncResult = await tailReadAsync(file, 0, Buffer.byteLength(first + second, 'utf8') + 2);
    assert.deepEqual(asyncResult.lines, [{ text: '你好' }, { text: '第二行' }]);
    assert.equal(asyncResult.newOffset, Buffer.byteLength(first + second, 'utf8'));
  } finally {
    fs.promises.readFile = originalReadFile;
  }

  fs.appendFileSync(file, '}\n', 'utf8');
  const resumed = tailRead(file, firstOffset + Buffer.byteLength(second, 'utf8'), 128);
  assert.deepEqual(resumed.lines, [{ text: '未完成' }]);
});
