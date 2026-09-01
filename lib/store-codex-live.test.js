'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const store = require('../test-support/store-fixture');

const source = fs.readFileSync(path.join(__dirname, 'store.js'), 'utf8');

test('Codex 普通日志只维持活跃，确认新回合时才取消完成观察期', () => {
  assert.match(source, /const freshCodexLog = ref\.startsWith\('codex:'\) && \(activeMap\.get\(ref\)\?\.lastActivity \|\| 0\) >= now - 10 \* 60 \* 1000;/);
  assert.match(source, /const freshExternalStatus = externalActiveAt\.has\(ref\);/);
  assert.match(source, /const freshWorkBuddyHeartbeat = ref\.startsWith\('workbuddy:'\)/);
  assert.match(source, /if \(\(!ts \|\| ts < now - 10 \* 60 \* 1000\) && !freshCodexLog && !freshExternalStatus && !freshWorkBuddyHeartbeat\) return false;/);
  assert.match(source, /const pendingCodexDone = new Map\(\);/);
  assert.match(source, /function setPendingCodexDone\(ref, signalTs, holdMs\)/);
  assert.match(source, /const completedAt = signalTs \|\| nowMs\(\);/);
  assert.match(source, /dueAt: completedAt \+ holdMs/);
  assert.match(source, /function noteCodexActivity\(ref, sourceTs, info\)/);
  assert.match(source, /function confirmCodexContinuation\(ref, sourceTs, info\)/);
  const noteBody = source.match(/function noteCodexActivity\(ref, sourceTs, info\) \{([\s\S]*?)\n\}/)?.[1] || '';
  assert.match(noteBody, /touchActive\(ref, info, Number\(sourceTs\) \|\| 0\);/);
  assert.match(noteBody, /agentStopAt\.delete\(ref\)/);
  assert.match(source, /if \(now < pending\.dueAt\) return true;/);
  assert.match(source, /if \(doneSignalAt\.has\(ref\)\) return false;/);
  assert.match(source, /if \(v < cutoff && !\(k\.startsWith\('codex:'\) && \(activeMap\.get\(k\)\?\.lastActivity \|\| 0\) >= cutoff\)\) lastMsgAt\.delete\(k\);/);
});

test('手动完成会话后，Codex runtime 快照不能把卡片状态恢复为进行中', () => {
  store.clearAll();
  const sessionId = '01a04ee4-4c26-7680-a583-42518889dee3';
  const ref = `codex:${sessionId}`;
  const now = Date.now();
  store.ingest({
    agent: 'codex', sourceId: 'manual-complete-user', sessionId,
    ts: now, role: 'user', kind: 'message', text: '执行子代理任务',
  });
  store.noteCodexThreadStatus(ref, { type: 'active', activeFlags: [] }, now);
  assert.equal(store.getRuntimeStatuses(now)[ref].state, 'running');

  store.setManualStatus('codex', sessionId, 'done');

  assert.equal(store.isLiveRef(ref, now), false);
  assert.equal(store.getRuntimeStatuses(now)[ref].state, 'completed');
  assert.equal(store.getSessions({ agent: 'codex' })[0].manual_done, true);
  assert.equal(store.getSessions({ agent: 'codex' })[0].runtime_status.state, 'completed');
  store.clearAll();
});
