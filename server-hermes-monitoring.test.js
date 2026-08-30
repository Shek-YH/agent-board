'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const hermesSource = fs.readFileSync(path.join(__dirname, 'lib', 'adapters', 'hermes.js'), 'utf8');

test('Hermes 兜底扫描间隔与看板刷新一致为 5 秒', () => {
  const block = source.match(/const hermesTimer = setInterval\(\(\) => \{([\s\S]*?)\n  \}, [^\n]+\);/);
  assert.ok(block, '应能找到 Hermes 兜底扫描定时器');
  assert.match(block[0], /hermes\.scanAll\(store\)/);
  assert.match(source, /const HERMES_SCAN_INTERVAL_MS = 5 \* 1000;/);
  assert.match(block[0], /\}, HERMES_SCAN_INTERVAL_MS\);/);
});

test('Hermes 扫描读取 session 级终态字段', () => {
  assert.match(hermesSource, /function sessionQueries\(db\)/);
  assert.match(hermesSource, /column\('ended_at'\)/);
  assert.match(hermesSource, /parseSessionStatus\(sessionForRows, latestMessage, topologyOverride\)/);
});
