'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const modulePath = path.join(__dirname, 'recent-completed-jump.js');

function loadSelector() {
  assert.ok(fs.existsSync(modulePath), 'recent-completed-jump.js should exist');
  const sandbox = { window: {} };
  vm.runInNewContext(fs.readFileSync(modulePath, 'utf8'), sandbox, { filename: modulePath });
  return sandbox.window.AgentBoardRecentCompletedJump;
}

test('选择完成时间最新且仍有已读提示的完成 session', () => {
  const { findLatestEligibleCompletion } = loadSelector();
  const now = 10_000;
  const sessions = [
    { id: 'codex:old', status: 'completed' },
    { id: 'codex:new', status: 'completed' },
    { id: 'codex:running', status: 'running' },
  ];
  const result = findLatestEligibleCompletion(sessions, {
    now,
    ttl: 2_000,
    recentDone: new Map([
      ['codex:old', 8_500],
      ['codex:new', 9_500],
      ['codex:running', 9_900],
    ]),
    dismissedRecent: new Set(),
    liveRefs: new Set(),
    runtimeStatuses: new Map(),
  });

  assert.equal(result.session.id, 'codex:new');
  assert.equal(result.completedAt, 9_500);
});

test('排除活跃、非完成、已读和过期 session，没有候选时返回 null', () => {
  const { findLatestEligibleCompletion } = loadSelector();
  const now = 10_000;
  const sessions = [
    { id: 'codex:live', status: 'completed' },
    { id: 'codex:paused', status: 'completed' },
    { id: 'codex:dismissed', status: 'completed' },
    { id: 'codex:expired', status: 'completed' },
    { id: 'codex:failed', status: 'failed' },
  ];
  const result = findLatestEligibleCompletion(sessions, {
    now,
    ttl: 2_000,
    recentDone: new Map([
      ['codex:live', 9_900],
      ['codex:paused', 9_800],
      ['codex:dismissed', 9_700],
      ['codex:expired', 7_000],
      ['codex:failed', 9_600],
    ]),
    dismissedRecent: new Set(['codex:dismissed']),
    liveRefs: new Set(['codex:live']),
    runtimeStatuses: new Map([['codex:paused', { state: 'paused' }]]),
  });

  assert.equal(result, null);
});
