'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const store = require('../test-support/store-fixture');
const { createWorkBuddyStatusBridge } = require('./adapters/workbuddy');

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

test('WorkBuddy spool 事件接入 store，并在稳定窗口后只产生一次完成提醒', async () => {
  store.clearAll();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-workbuddy-bridge-'));
  const spoolPath = path.join(directory, 'events.spool');
  const sessionId = 'unit-status-bridge';
  const now = Date.now();
  fs.writeFileSync(spoolPath, [
    { event: 'SessionStart', session_id: sessionId, ts: now },
    { event: 'UserPromptSubmit', session_id: sessionId, ts: now + 1 },
    { event: 'Stop', session_id: sessionId, ts: now + 2, ends_with_question: false },
  ].map((event) => JSON.stringify(event)).join('\n') + '\n');

  try {
    const bridge = createWorkBuddyStatusBridge({ spoolPaths: [spoolPath], stabilizationMs: 5 });
    const liveCompletions = [];
    bridge.setListeners({ onCompletion: (completion) => liveCompletions.push(completion) });
    const first = bridge.scan(store);
    assert.equal(first.eventCount, 3);
    assert.equal(store.getRuntimeStatuses()[`workbuddy:${sessionId}`].state, 'running');

    await wait(15);
    assert.equal(liveCompletions.length, 1);
    const second = bridge.scan(store);
    assert.equal(second.completions.length, 1);
    assert.equal(second.completions[0].sessionId, sessionId);
    assert.equal(store.isLiveRef(`workbuddy:${sessionId}`, now + 3), false);

    const third = bridge.scan(store);
    assert.equal(third.eventCount, 0);
    assert.equal(third.completions.length, 0);

    const restarted = createWorkBuddyStatusBridge({ spoolPaths: [spoolPath], stabilizationMs: 5 });
    const replay = restarted.scan(store, { baseline: true });
    assert.equal(replay.eventCount, 0);
    assert.equal(replay.completions.length, 0);
  } finally {
    store.clearAll();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('WorkBuddy bridge 传递后台任务能力并等待 task_notification 终态', async () => {
  store.clearAll();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-workbuddy-bridge-bg-'));
  const spoolPath = path.join(directory, 'events.spool');
  const sessionId = 'unit-status-bridge-bg';
  const now = Date.now();
  fs.writeFileSync(spoolPath, [
    { event: 'UserPromptSubmit', session_id: sessionId, ts: now },
    { event: 'task_started', session_id: sessionId, task_id: 'bg-1', task_type: 'Bash', ts: now + 1 },
    { event: 'Stop', session_id: sessionId, ts: now + 2 },
  ].map((event) => JSON.stringify(event)).join('\n') + '\n');

  try {
    const bridge = createWorkBuddyStatusBridge({
      spoolPaths: [spoolPath],
      stabilizationMs: 5,
      capabilities: { backgroundTaskEvents: true },
    });
    const first = bridge.scan(store);
    assert.equal(first.eventCount, 3);
    assert.equal(store.getRuntimeStatuses()[`workbuddy:${sessionId}`].activeBackgroundTaskCount, 1);
    await wait(15);
    assert.equal(store.getRuntimeStatuses()[`workbuddy:${sessionId}`].state, 'running');

    fs.appendFileSync(spoolPath, `${JSON.stringify({
      event: 'task_notification', session_id: sessionId, task_id: 'bg-1', status: 'completed', ts: now + 3,
    })}\n`);
    const second = bridge.scan(store);
    assert.equal(second.eventCount, 1);
    await wait(15);
    assert.equal(bridge.scan(store).completions.length, 1);
    assert.equal(store.getRuntimeStatuses()[`workbuddy:${sessionId}`].state, 'completed');
  } finally {
    store.clearAll();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('WorkBuddy bridge 可直接接收 HTTP Hook 事件，不依赖 spool 扫描', async () => {
  store.clearAll();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-workbuddy-bridge-http-'));
  const spoolPath = path.join(directory, 'events.spool');
  const sessionId = 'unit-status-bridge-http';
  const now = Date.now();
  try {
    const bridge = createWorkBuddyStatusBridge({
      spoolPaths: [spoolPath],
      stabilizationMs: 5,
      capabilities: { httpHook: true },
    });
    const result = bridge.ingest(store, [
      { event: 'SessionStart', session_id: sessionId, ts: now },
      { event: 'UserPromptSubmit', session_id: sessionId, ts: now + 1 },
      { event: 'Stop', session_id: sessionId, ts: now + 2 },
    ]);
    assert.equal(result.eventCount, 3);
    assert.equal(result.capabilities.httpHook, true);
    await wait(15);
    assert.equal(bridge.scan(store).completions.length, 1);
  } finally {
    store.clearAll();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
