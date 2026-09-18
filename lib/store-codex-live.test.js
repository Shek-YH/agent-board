'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const store = require('../test-support/store-fixture');

const source = fs.readFileSync(path.join(__dirname, 'store.js'), 'utf8');

test('Codex 普通日志只维持活跃，确认新回合时才取消完成观察期', () => {
  // Codex 的日志证据不能只认「活跃指针新鲜」：threadStatus=active 但 lastEventAt 早已超时的
  // 会话，codex-status 会输出 stale_active（=「状态待确认」），此时若仍算进行中，
  // liveRefs 就会与 status 层互相矛盾（卡片既在跑又「待确认」）。
  // 因此判定统一走 isFreshCodexEvidence()，与 codex-status 共用同一条老化规则。
  assert.match(source, /const freshCodexLog = ref\.startsWith\('codex:'\) && isFreshCodexEvidence\(ref, now\);/);
  assert.match(source, /function isFreshCodexEvidence\(ref, now\) \{/);
  assert.match(source, /const codexEvidenceFresh = now - lastEventAt <= CODEX_STALE_ACTIVE_MS;/);
  assert.match(source, /return activityFresh && codexEvidenceFresh;/);
  assert.match(source, /const CODEX_STALE_ACTIVE_MS = codexStatus\.STALE_ACTIVE_MS \?\? 10 \* 60 \* 1000;/);
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

test('Codex 完成信号确认后，生命周期状态不能停留在完成候选', () => {
  store.clearAll();
  const sessionId = 'codex-completion-confirmed';
  const ref = `codex:${sessionId}`;
  const now = Date.now();
  store.ingest({
    agent: 'codex', sourceId: 'completion-confirmed-user', sessionId,
    ts: now - 1000, role: 'user', kind: 'message', text: '执行任务',
  });
  store.ingest({
    agent: 'codex', sourceId: 'completion-confirmed-turn-end', sessionId,
    ts: now, kind: 'turn_end', turnId: 'turn-1', turnStatus: 'completed',
    completionHoldMs: 5000,
  });
  assert.equal(store.getRuntimeStatuses(now)[ref].lifecycle_state, 'COMPLETION_CANDIDATE');

  store.setDoneSignal(ref, now);

  assert.equal(store.isLiveRef(ref, now), false);
  assert.equal(store.getRuntimeStatuses(now)[ref].lifecycle_state, 'COMPLETED');
  assert.equal(store.getRuntimeStatuses(now)[ref].state, 'completed');
  store.clearAll();
});
