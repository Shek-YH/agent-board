'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, 'store.js'), 'utf8');

test('Codex 的新日志写入保持会话进行中，并忽略旧的回合完成信号', () => {
  assert.match(source, /const freshCodexLog = ref\.startsWith\('codex:'\) && \(activeMap\.get\(ref\)\?\.lastActivity \|\| 0\) >= now - 10 \* 60 \* 1000;/);
  assert.match(source, /if \(\(!ts \|\| ts < now - 10 \* 60 \* 1000\) && !freshCodexLog\) return false;/);
  assert.match(source, /if \(!ref\.startsWith\('codex:'\) && doneSignalAt\.has\(ref\)\) return false;/);
  assert.match(source, /if \(v < cutoff && !\(k\.startsWith\('codex:'\) && \(activeMap\.get\(k\)\?\.lastActivity \|\| 0\) >= cutoff\)\) lastMsgAt\.delete\(k\);/);
});
