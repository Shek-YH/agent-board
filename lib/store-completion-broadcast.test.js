'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const store = require('../test-support/store-fixture');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 造一个存在会话元数据的 ref（confirm 阶段要求 sessions.has(ref)）
function seedSession(agent, sessionId, role = 'assistant', text = '回复内容', ts = Date.now()) {
  store.ingest({
    agent, sourceId: `${agent}-seed-${sessionId}-${Math.random()}`, sessionId,
    ts, role, kind: 'message', text,
  });
  return `${agent}:${sessionId}`;
}

test('通用完成出口：窗口表内 agent 的 setDoneSignal 经稳定窗后广播一次完成事件', async () => {
  store.clearAll();
  store.setCompletionStabilizeMs('marvis', 5);
  const received = [];
  const off = store.onAgentCompletion((ev) => received.push(ev));
  try {
    const sessionId = 'conv-1001';
    const ref = seedSession('marvis', sessionId);
    const at = Date.now() + 100; // 完成时刻晚于最后消息，避免活体否决
    store.setDoneSignal(ref, at);
    await wait(30);
    assert.equal(received.length, 1);
    assert.equal(received[0].provider, 'marvis');
    assert.equal(received[0].sessionId, sessionId);
    assert.equal(received[0].completedAt, at);
    assert.match(received[0].completionId, /^marvis:conv-1001@/);
    // 同一完成重复上报不重复广播
    store.setDoneSignal(ref, at);
    await wait(10);
    assert.equal(received.length, 1);
  } finally {
    off();
  }
});

test('CLI 轮次型 agent（claude）的 setDoneSignal(turn_end) 不广播，但进程退出会广播', async () => {
  store.clearAll();
  store.setCompletionStopWindowMs(5); // 停表兜底窗改短（claude 不在稳定窗表，走 allowStop 兜底窗）
  const received = [];
  const off = store.onAgentCompletion((ev) => received.push(ev));
  try {
    const sessionId = 'uuid-claude-1';
    const ref = seedSession('claude', sessionId);
    store.setDoneSignal(ref, Date.now() + 100);
    await wait(30);
    assert.equal(received.length, 0); // turn_end 不进窗表 → 不广播（CLI 进程仍活，防误报）
    // 进程退出（agentStopAt）才是 claude 的真正完成 → 走 allowStop 路径广播
    const stopAt = Date.now() + 200;
    store.setAgentStopped('claude', true, stopAt);
    await wait(30);
    assert.equal(received.length, 1);
    assert.equal(received[0].agent, 'claude');
    assert.equal(received[0].sessionId, sessionId);
  } finally {
    off();
  }
});

test('zcode 进程退出同样走 allowStop 广播（不在稳定窗表）', async () => {
  store.clearAll();
  store.setCompletionStopWindowMs(5);
  const received = [];
  const off = store.onAgentCompletion((ev) => received.push(ev));
  try {
    const sessionId = 'sess_zk_1';
    seedSession('zcode', sessionId);
    const stopAt = Date.now() + 50;
    store.setAgentStopped('zcode', true, stopAt);
    await wait(30);
    assert.equal(received.length, 1);
    assert.equal(received[0].agent, 'zcode');
    assert.equal(received[0].sessionId, sessionId);
  } finally {
    off();
  }
});

test('interrupted/cancelled 回合结束只翻 done，不广播完成弹窗', async () => {
  store.clearAll();
  store.setCompletionStabilizeMs('marvis', 5);
  const received = [];
  const off = store.onAgentCompletion((ev) => received.push(ev));
  try {
    const sessionId = 'conv-abort-1';
    seedSession('marvis', sessionId, 'assistant', '部分回复', Date.now());
    store.ingest({
      agent: 'marvis', sourceId: 'abort-1', sessionId,
      ts: Date.now() + 50, role: 'assistant', kind: 'turn_end', text: '',
      turnStatus: 'interrupted',
    });
    await wait(30);
    assert.equal(received.length, 0);
    // 正常完成的 turn_end 应广播
    store.ingest({
      agent: 'marvis', sourceId: 'done-1', sessionId,
      ts: Date.now() + 100, role: 'assistant', kind: 'turn_end', text: '',
      turnStatus: 'completed',
    });
    await wait(30);
    assert.equal(received.length, 1);
    assert.equal(received[0].sessionId, sessionId);
  } finally {
    off();
  }
});

test('候选期间出现新真实消息 → 撤销，不广播（活体否决，防误报）', async () => {
  store.clearAll();
  store.setCompletionStabilizeMs('hermes', 30);
  const received = [];
  const off = store.onAgentCompletion((ev) => received.push(ev));
  try {
    const sessionId = 'sess-2001';
    const ref = seedSession('hermes', sessionId, 'assistant', '第一段', Date.now());
    const at = Date.now() + 100;
    store.setDoneSignal(ref, at);
    // 完成候选期间会话复活（新真实消息晚于完成时刻）
    seedSession('hermes', sessionId, 'user', '继续', at + 1);
    await wait(60);
    assert.equal(received.length, 0);
  } finally {
    off();
  }
});

test('workbuddy 不走通用出口（monitor 独占）', async () => {
  store.clearAll();
  store.setCompletionStabilizeMs('workbuddy', 5);
  const received = [];
  const off = store.onAgentCompletion((ev) => received.push(ev));
  try {
    const sessionId = 'wb-uuid-1';
    seedSession('workbuddy', sessionId);
    store.setDoneSignal(`workbuddy:${sessionId}`, Date.now() + 100);
    store.setAgentActive(`workbuddy:${sessionId}`, false, Date.now() + 200);
    await wait(30);
    assert.equal(received.length, 0);
  } finally {
    off();
  }
});

test('child 会话（subagent）不上报完成弹窗', async () => {
  store.clearAll();
  store.setCompletionStabilizeMs('marvis', 5);
  const received = [];
  const off = store.onAgentCompletion((ev) => received.push(ev));
  try {
    const childRef = 'marvis:parent-1:subagent:agent-x';
    seedSession('marvis', 'parent-1:subagent:agent-x');
    store.setDoneSignal(childRef, Date.now() + 100);
    await wait(30);
    assert.equal(received.length, 0);
  } finally {
    off();
  }
});

test('停顿检测重复 tick（Date.now 递增）只广播一次；新消息复活后可再广播', async () => {
  store.clearAll();
  store.setCompletionStabilizeMs('deepseek', 5); // deepseek 在稳定窗表（4000ms），缩短便于测试
  const received = [];
  const off = store.onAgentCompletion((ev) => received.push(ev));
  try {
    const sessionId = 'sess-idle-1';
    const ref = seedSession('deepseek', sessionId, 'assistant', '回复内容', Date.now());
    // tick1：停顿 → allowStop 候选 → 广播
    store.setAgentActive(ref, false, Date.now() + 100);
    await wait(50);
    assert.equal(received.length, 1, '第一次停顿应广播一次');
    // tick2..tick4：同一静止期重复停顿（Date.now 递增，模拟 20s deskTimer）
    // → store 守卫：已广播且自上次广播后无新活动 → 不再登记 → 不重复广播
    store.setAgentActive(ref, false, Date.now() + 150);
    store.setAgentActive(ref, false, Date.now() + 170);
    store.setAgentActive(ref, false, Date.now() + 190);
    await wait(80);
    assert.equal(received.length, 1, '静止期重复 tick 不得重复广播');
    // resume：新真实消息晚于上次广播时刻 → 再停顿允许新一轮广播
    seedSession('deepseek', sessionId, 'user', '继续', Date.now() + 200);
    store.setAgentActive(ref, false, Date.now() + 220);
    await wait(50);
    assert.equal(received.length, 2, '新活动后再停顿应能再次广播');
  } finally {
    off();
  }
});
