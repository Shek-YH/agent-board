'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const serverSource = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const storeSource = fs.readFileSync(path.join(__dirname, 'lib', 'store.js'), 'utf8');

test('启动扫描批次跳过重复的大快照保存，并在扫描结束后统一刷新', () => {
  const scanStart = serverSource.indexOf('async function scanAll');
  const scanEnd = serverSource.indexOf('\nfunction pollChanged', scanStart);
  const scan = serverSource.slice(scanStart, scanEnd);

  assert.match(storeSource, /function tx\(fn, \{ persist = true \} = \{\}\)/);
  assert.match(storeSource, /function flushPersistence\(\)/);
  assert.match(scan, /store\.tx\(\(\) => \{[\s\S]*?\}, \{ persist: false \}\)/);
  assert.match(scan, /store\.flushPersistence\(\);/);

  const heartbeatTimer = serverSource.slice(serverSource.indexOf('const hbTimer = setInterval'), serverSource.indexOf('const statusTimer = setInterval'));
  const titleTimer = serverSource.slice(serverSource.indexOf('const codexTitleTimer = setInterval'), serverSource.indexOf('const dsTimer = setInterval'));
  assert.match(heartbeatTimer, /if \(isScanning\) return;/);
  assert.match(titleTimer, /if \(isScanning\) return;/);
});
