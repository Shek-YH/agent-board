'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

test('scanAll 支持启动、温项目和全量三种模式', () => {
  assert.match(source, /async function scanAll\(\{ full = false, maxAgeMs/);
  assert.match(source, /maxAgeMs = SCAN_DAYS \* DAY_MS/);
  assert.match(source, /a\.scanAll\(store, \{ cutoff \}\)/);
});

test('扫描期间文件事件进入队列而不是并发 poll', () => {
  assert.match(source, /pendingChangedPaths/);
  assert.match(source, /if \(isScanning \|\| drainingChangedPaths\)/);
});

test('server 通过统一调度器记录全量扫描时间并在监听后启动', () => {
  assert.match(source, /createScanScheduler/);
  assert.match(source, /scan:last-full-at/);
  assert.match(source, /scanScheduler\.start\(\)/);
});

test('启动扫描使用 24 小时窗口，温项目校对使用 7 天窗口', () => {
  assert.match(source, /scanScheduler\.request\('startup-recent'\)/);
  assert.match(source, /scanScheduler\.request\('warm-reconcile'\)/);
});
