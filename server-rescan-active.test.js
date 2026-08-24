'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

test('全量重扫结束后只推送当前活跃会话快照', () => {
  const rescan = source.slice(source.indexOf("if (pathname === '/api/rescan'"));
  assert.match(rescan, /sseBroadcast\('active', store\.getActive\(\)\)/);
  assert.doesNotMatch(rescan, /sseBroadcast\('active', store\.getRecentActive\('day'\)\)/);
  assert.match(source, /setInterval\(\(\) => \{\s*if \(!isScanning\) sseBroadcast\('active', store\.getActive\(\)\);\s*\}, 5000\)/);
});
