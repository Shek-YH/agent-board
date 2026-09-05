'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const store = require('../test-support/store-fixture');

test('无持久化变更时 flushPersistence 不生成新快照', async () => {
  await store.flushPersistence();
  assert.equal(fs.existsSync(store.DATA_PATH), false);
});

test('批量事务可跳过延迟快照保存，避免扫描期间反复序列化大数据集', async () => {
  store.tx(() => {
    store.ingest({
      agent: 'claude', sourceId: 'persistence-batch', sessionId: 'persistence-batch',
      ts: Date.now(), role: 'user', kind: 'message', text: '批量持久化测试',
    });
  }, { persist: false });

  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.equal(fs.existsSync(store.DATA_PATH), false);
});

test('扫描时间元数据可以通过现有 meta 快照持久化', async () => {
  store.stmts.setMeta.run('scan:last-full-at', '123456789');
  await store.flushPersistence();
  assert.match(fs.readFileSync(store.DATA_PATH, 'utf8'), /scan:last-full-at/);
});
