'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, 'store.js'), 'utf8');

test('项目统计包含按项目聚合的最新会话时间', () => {
  assert.match(source, /lastSeen: Math\.max\(current\.lastSeen, s\.last_seen \|\| 0\)/);
});
