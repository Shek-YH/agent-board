'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  appendHostedAgentContract,
  classifyHostedAgentReply,
  normalizeHostedControl,
} = require('./hosted-agent');

test('hosted agent contract requires structured progress replies and autonomous ordinary decisions', () => {
  const instruction = appendHostedAgentContract('继续完成当前目标。');

  assert.match(instruction, /STATUS:.*WORKING.*WAITING_FOR_HOST.*BLOCKED.*COMPLETED/);
  assert.match(instruction, /普通问题|页面|技术方案/);
  assert.match(instruction, /不要.*请确认|不要.*等待用户/);
  assert.match(instruction, /Evidence/);
});

test('hosted reply classifier distinguishes ordinary questions from safety blockers', () => {
  const ordinary = classifyHostedAgentReply({ messages: [
    { source_id: 'assistant-1', role: 'assistant', ts: 20, text: '页面需要选择两种布局，你希望哪一种？' },
  ] });
  assert.equal(ordinary.status, 'question');
  assert.equal(ordinary.requiresHostDecision, true);
  assert.equal(ordinary.safetyBoundary, false);
  assert.match(ordinary.messageId, /^[a-f0-9]{32}$/);

  const safety = classifyHostedAgentReply({ messages: [
    { source_id: 'assistant-2', role: 'assistant', ts: 30, text: '请确认是否允许读取 API token 并发送到外部服务。' },
  ] });
  assert.equal(safety.status, 'blocked');
  assert.equal(safety.requiresHostDecision, false);
  assert.equal(safety.safetyBoundary, true);
});

test('hosted reply keeps an explicit waiting status when safety boundaries are reported as not performed', () => {
  const waiting = classifyHostedAgentReply({ messages: [
    { source_id: 'assistant-waiting', role: 'assistant', ts: 40, text: [
      'STATUS: WAITING_FOR_HOST',
      'DONE: 已完成需求问题整理。',
      'BLOCKED: 等待用户回答。',
      'EVIDENCE: 未安装依赖、未发布网站、未修改未同意的内容。',
    ].join('\n') },
  ] });

  assert.equal(waiting.status, 'waiting_for_host');
  assert.equal(waiting.requiresHostDecision, true);
  assert.equal(waiting.safetyBoundary, false);
});

test('hosted reply does not block on a mere operational mention of network or an external service', () => {
  const working = classifyHostedAgentReply({ messages: [
    { source_id: 'assistant-weather', role: 'assistant', ts: 50, text: 'STATUS: WORKING\nDONE: 正在联网查询天气数据。\nNEXT: 稍后返回结果。' },
  ] });
  assert.equal(working.status, 'working');
  assert.equal(working.safetyBoundary, false);
});

test('hosted reply stays completed even when it reports completion and mentions an external call', () => {
  const done = classifyHostedAgentReply({ messages: [
    { source_id: 'assistant-weather-done', role: 'assistant', ts: 60, text: 'STATUS: COMPLETED\nDONE: 已获取天气结果。\nEVIDENCE: 通过联网外部服务查询完成。' },
  ] });
  assert.equal(done.status, 'completed');
  assert.equal(done.safetyBoundary, false);
});

test('hosted reply still blocks on an explicit intent to run a destructive operation', () => {
  const del = classifyHostedAgentReply({ messages: [
    { source_id: 'assistant-delete', role: 'assistant', ts: 70, text: '接下来我将删除项目目录并清空数据。' },
  ] });
  assert.equal(del.status, 'blocked');
  assert.equal(del.safetyBoundary, true);
});

test('hosted reply does not treat "覆盖点" (decimal point) as a destructive overwrite safety boundary', () => {
  const r = classifyHostedAgentReply({ messages: [
    { source_id: 'assistant-cov-point', role: 'assistant', ts: 71, text: 'STATUS: BLOCKED\nDONE: 已完成。\nBLOCKED: 未明确测试用例数量、是否需覆盖点、大数、负数。' },
  ] });
  // 「覆盖点」= 小数点，属普通测试用例歧义，不是「覆盖文件」这类破坏性操作。
  assert.equal(r.realSafetyBoundary, false);
  // 声明 BLOCKED 但无真实边界词 + 带完成证据 → 自动归为 completed（可自动收尾 DONE）。
  assert.equal(r.status, 'completed');
});

test('hosted control persists task relation and only safe message fingerprints', () => {
  const state = normalizeHostedControl({
    enabled: true, sourceTaskId: 'source-task', targetTaskId: 'target-task', hostId: 'host-1',
    round: 3, lastSentMessageId: 'message-secret', lastAgentMessageId: 'reply-secret', lastHandledAgentMessageId: 'reply-secret',
    lastAgentMessageStatus: 'question', lastAgentMessageText: 'raw reply must not persist',
  });

  assert.deepEqual(state, {
    enabled: true, sourceTaskId: 'source-task', targetTaskId: 'target-task', hostId: 'host-1', round: 3,
    lastSentMessageId: 'message-secret', lastAgentMessageId: 'reply-secret', lastHandledAgentMessageId: 'reply-secret',
    lastAgentMessageStatus: 'question', lastAgentMessageAt: null, lastDecisionAt: null,
    blockedReason: '',
  });
  assert.equal('lastAgentMessageText' in state, false);
});
