'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, 'store.js'), 'utf8');

test('Codex 普通日志只维持活跃，确认新回合时才取消完成观察期', () => {
  assert.match(source, /const freshCodexLog = ref\.startsWith\('codex:'\) && \(activeMap\.get\(ref\)\?\.lastActivity \|\| 0\) >= now - 10 \* 60 \* 1000;/);
  assert.match(source, /const freshExternalStatus = externalActiveAt\.has\(ref\);/);
  assert.match(source, /if \(\(!ts \|\| ts < now - 10 \* 60 \* 1000\) && !freshCodexLog && !freshExternalStatus\) return false;/);
  assert.match(source, /const pendingCodexDone = new Map\(\);/);
  assert.match(source, /function setPendingCodexDone\(ref, signalTs, holdMs\)/);
  assert.match(source, /const completedAt = signalTs \|\| nowMs\(\);/);
  assert.match(source, /dueAt: completedAt \+ holdMs/);
  assert.match(source, /function noteCodexActivity\(ref, sourceTs, info\)/);
  assert.match(source, /function confirmCodexContinuation\(ref, sourceTs, info\)/);
  const noteBody = source.match(/function noteCodexActivity\(ref, sourceTs, info\) \{([\s\S]*?)\n\}/)?.[1] || '';
  assert.match(noteBody, /touchActive\(ref, info, nowMs\(\)\);/);
  assert.match(noteBody, /agentStopAt\.delete\(ref\)/);
  assert.match(source, /if \(now < pending\.dueAt\) return true;/);
  assert.match(source, /if \(doneSignalAt\.has\(ref\)\) return false;/);
  assert.match(source, /if \(v < cutoff && !\(k\.startsWith\('codex:'\) && \(activeMap\.get\(k\)\?\.lastActivity \|\| 0\) >= cutoff\)\) lastMsgAt\.delete\(k\);/);
});
