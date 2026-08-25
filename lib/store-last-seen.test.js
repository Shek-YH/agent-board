'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, 'store.js'), 'utf8');
const normalizedSource = source.replace(/\r\n/g, '\n');

test('活动探测时间不污染会话的真实排序时间', () => {
  const touchActive = normalizedSource.match(/function touchActive\([\s\S]*?\n}\n\n(?=function )/);
  assert.ok(touchActive, '应能找到 touchActive 实现');
  assert.doesNotMatch(touchActive[0], /s\.last_seen/);
  assert.match(normalizedSource, /if \(msg\.ts > s\.last_seen\) s\.last_seen = msg\.ts;/);
});
