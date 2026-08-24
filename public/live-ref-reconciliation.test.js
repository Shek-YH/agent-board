'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

test('board 快照会移除已完成但 SSE 丢失留下的旧活跃 ref', () => {
  assert.match(source, /state\.liveRefs = new Set\(d\.liveRefs\);/);
  assert.doesNotMatch(source, /const next = new Set\(d\.liveRefs\);[\s\S]*?for \(const r of state\.liveRefs\) next\.add\(r\);/);
});
