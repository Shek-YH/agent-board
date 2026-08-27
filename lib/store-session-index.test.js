'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, 'store.js'), 'utf8');
const start = source.indexOf('function getSession(ref)');
const end = source.indexOf('function getSessionTitle', start);
const getSessionBody = source.slice(start, end);

test('详情抽屉通过按 session 建立的消息索引读取，不扫描全量消息', () => {
  assert.match(source, /const messagesBySession = new Map\(\)/);
  assert.match(getSessionBody, /messagesBySession\.get\(ref\)/);
  assert.doesNotMatch(getSessionBody, /messages\.values\(\)/);
});

test('大快照保存不使用同步写盘阻塞事件循环', () => {
  const saveStart = source.indexOf('function save()');
  const saveEnd = source.indexOf('// 保存失败落盘日志', saveStart);
  const saveBody = source.slice(saveStart, saveEnd);
  assert.match(saveBody, /fs\.promises/);
  assert.doesNotMatch(saveBody, /writeFileSync|renameSync/);
});
