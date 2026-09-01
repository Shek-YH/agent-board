'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createWorkBuddyMonitor, WORKBUDDY_INTERNAL_STATES } = require('./workbuddy-monitor');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeMonitor(options = {}) {
  const notifications = [];
  const failures = [];
  const diagnostics = [];
  const states = [];
  const monitor = createWorkBuddyMonitor({
    stabilizationMs: 5,
    onStatus: (state) => states.push(state),
    onCompletion: (event) => notifications.push(event),
    onFailure: (event) => failures.push(event),
    onDiagnostic: (event) => diagnostics.push(event),
    ...options,
  });
  return { monitor, notifications, failures, diagnostics, states };
}

function event(event, ts, extra = {}) {
  return { event, ts, session_id: 'session-1', ...extra };
}

test('V1.1 内部状态模型保留 planning 与 candidate_completion', () => {
  assert.ok(WORKBUDDY_INTERNAL_STATES.includes('planning'));
  assert.ok(WORKBUDDY_INTERNAL_STATES.includes('candidate_completion'));
});

test('缺失 UserPromptSubmit 时，新的工具生命周期可作为当前轮次证据', async () => {
  const { monitor, notifications } = makeMonitor();
  monitor.handle(event('SessionStart', 100));
  monitor.handle(event('PreToolUse', 110, { tool_use_id: 'tool-without-prompt' }));
  monitor.handle(event('PostToolUse', 120, { tool_use_id: 'tool-without-prompt' }));
  monitor.handle(event('Stop', 130));
  await wait(15);
  assert.equal(monitor.get('session-1').status, 'completed');
  assert.equal(notifications.length, 1);
});

test('普通 WorkBuddy 轮次只有主 Stop 才完成并提醒一次', async () => {
  const { monitor, notifications } = makeMonitor();
  monitor.handle(event('UserPromptSubmit', 100));
  monitor.handle(event('PreToolUse', 110, { tool_use_id: 'tool-1' }));
  monitor.handle(event('PostToolUse', 120, { tool_use_id: 'tool-1' }));
  monitor.handle(event('Stop', 130));

  assert.notEqual(monitor.get('session-1').status, 'completed');
  await wait(15);
  assert.equal(monitor.get('session-1').status, 'completed');
  assert.equal(notifications.length, 1);
});

test('多个工具完成前保持处理中，主 Stop 后才完成', async () => {
  const { monitor, notifications } = makeMonitor();
  monitor.handle(event('UserPromptSubmit', 100));
  monitor.handle(event('PreToolUse', 110, { tool_use_id: 'tool-a' }));
  monitor.handle(event('PostToolUse', 120, { tool_use_id: 'tool-a' }));
  monitor.handle(event('PreToolUse', 130, { tool_use_id: 'tool-b' }));
  assert.notEqual(monitor.get('session-1').status, 'completed');
  monitor.handle(event('PostToolUse', 140, { tool_use_id: 'tool-b' }));
  assert.equal(notifications.length, 0);
  monitor.handle(event('Stop', 150));
  await wait(15);
  assert.equal(monitor.get('session-1').status, 'completed');
  assert.equal(notifications.length, 1);
});

test('子 Agent 完成不等于主轮次完成，必须等待主 Stop', async () => {
  const { monitor, notifications } = makeMonitor();
  monitor.handle(event('UserPromptSubmit', 100));
  monitor.handle(event('SubagentStart', 110, { subagent_id: 'child-1' }));
  monitor.handle(event('SubagentStop', 120, { subagent_id: 'child-1' }));
  await wait(15);
  assert.notEqual(monitor.get('session-1').status, 'completed');
  assert.equal(notifications.length, 0);
  monitor.handle(event('Stop', 130));
  await wait(15);
  assert.equal(monitor.get('session-1').status, 'completed');
  assert.equal(notifications.length, 1);
});

test('主 Stop 早于仍活跃的子 Agent 时，子 Agent 结束后才确认完成', async () => {
  const { monitor, notifications } = makeMonitor();
  monitor.handle(event('UserPromptSubmit', 100));
  monitor.handle(event('SubagentStart', 110, { subagent_id: 'child-a' }));
  monitor.handle(event('SubagentStart', 111, { subagent_id: 'child-b' }));
  monitor.handle(event('SubagentStop', 112, { subagent_id: 'child-a' }));
  monitor.handle(event('Stop', 120));
  await wait(15);
  assert.notEqual(monitor.get('session-1').status, 'completed');
  assert.equal(notifications.length, 0);
  monitor.handle(event('SubagentStop', 130, { subagent_id: 'child-b' }));
  await wait(15);
  assert.equal(monitor.get('session-1').status, 'completed');
  assert.equal(notifications.length, 1);
});

test('权限等待保持 waiting_user，但问号只能作为弱启发式', async () => {
  const permission = makeMonitor();
  permission.monitor.handle(event('UserPromptSubmit', 100));
  permission.monitor.handle(event('PermissionRequest', 110));
  permission.monitor.handle(event('Stop', 120));
  await wait(15);
  assert.equal(permission.monitor.get('session-1').status, 'waiting_user');
  assert.equal(permission.notifications.length, 0);

  const question = makeMonitor();
  question.monitor.handle(event('UserPromptSubmit', 100));
  question.monitor.handle(event('Stop', 120, { ends_with_question: true }));
  await wait(15);
  assert.equal(question.monitor.get('session-1').status, 'completed');
  assert.equal(question.monitor.get('session-1').lastQuestionSignal, true);
  assert.equal(question.notifications.length, 1);
});

test('stop_hook_active=true 只表示继续执行，不得完成或提醒', async () => {
  const { monitor, notifications } = makeMonitor();
  monitor.handle(event('UserPromptSubmit', 100));
  monitor.handle(event('Stop', 120, { stop_hook_active: true }));
  await wait(15);
  assert.equal(monitor.get('session-1').status, 'thinking');
  assert.equal(monitor.get('session-1').internalState, 'running');
  assert.equal(monitor.get('session-1').lastStopHookActive, true);
  assert.equal(notifications.length, 0);

  monitor.handle(event('PreToolUse', 130, { tool_use_id: 'continued-tool' }));
  monitor.handle(event('PostToolUse', 140, { tool_use_id: 'continued-tool' }));
  monitor.handle(event('Stop', 150, { stop_hook_active: false }));
  await wait(15);
  assert.equal(monitor.get('session-1').status, 'completed');
  assert.equal(notifications.length, 1);
});

test('Notification 的官方等待类型优先于问号 heuristic，并可被新活动清除', async () => {
  const { monitor, notifications } = makeMonitor();
  monitor.handle(event('UserPromptSubmit', 100));
  monitor.handle(event('Notification', 110, { notification_type: 'permission_prompt' }));
  assert.equal(monitor.get('session-1').status, 'waiting_user');
  assert.equal(monitor.get('session-1').waitingFromNotification, true);
  monitor.handle(event('Stop', 120, { ends_with_question: false }));
  await wait(15);
  assert.equal(monitor.get('session-1').status, 'waiting_user');
  assert.equal(notifications.length, 0);

  monitor.handle(event('UserPromptSubmit', 200));
  assert.equal(monitor.get('session-1').waitingFromNotification, false);
  monitor.handle(event('Stop', 220));
  await wait(15);
  assert.equal(notifications.length, 1);
});

test('已完成回合收到 idle_prompt 后仍保持 completed', async () => {
  const { monitor, notifications } = makeMonitor();
  monitor.handle(event('UserPromptSubmit', 100));
  monitor.handle(event('Stop', 120));
  await wait(15);

  assert.equal(monitor.get('session-1').status, 'completed');
  monitor.handle(event('Notification', 200, { notification_type: 'idle_prompt' }));

  assert.equal(monitor.get('session-1').status, 'completed');
  assert.equal(monitor.get('session-1').waitingFromNotification, false);
  assert.equal(notifications.length, 1);
});

test('可观测后台任务未结束时不能完成，终态后只提醒一次', async () => {
  const { monitor, notifications } = makeMonitor({
    capabilities: { backgroundTaskEvents: true },
  });
  monitor.handle(event('UserPromptSubmit', 100));
  monitor.handle({
    type: 'system', subtype: 'task_started', session_id: 'session-1',
    task_id: 'bg-1', task_type: 'Bash', ts: 110,
  });
  monitor.handle(event('Stop', 120));
  await wait(15);
  assert.equal(monitor.get('session-1').status, 'candidate_completion');
  assert.equal(monitor.get('session-1').activeBackgroundTaskCount, 1);
  assert.equal(notifications.length, 0);

  monitor.handle({
    type: 'system', subtype: 'task_notification', session_id: 'session-1',
    task_id: 'bg-1', status: 'completed', ts: 130,
  });
  await wait(15);
  assert.equal(monitor.get('session-1').status, 'completed');
  assert.equal(monitor.get('session-1').activeBackgroundTaskCount, 0);
  assert.equal(notifications.length, 1);
});

test('后台任务失败会阻止普通完成提醒', async () => {
  const { monitor, notifications, failures } = makeMonitor({
    capabilities: { backgroundTaskEvents: true },
  });
  monitor.handle(event('UserPromptSubmit', 100));
  monitor.handle({
    type: 'system', subtype: 'task_started', session_id: 'session-1',
    task_id: 'bg-failed', ts: 110,
  });
  monitor.handle(event('Stop', 120));
  monitor.handle({
    type: 'system', subtype: 'task_notification', session_id: 'session-1',
    task_id: 'bg-failed', status: 'failed', ts: 130,
  });
  await wait(15);
  assert.equal(monitor.get('session-1').status, 'failed');
  assert.equal(notifications.length, 0);
  assert.equal(failures.length, 1);
});

test('StopFailure 进入 failed，且不会产生 completed 提醒', async () => {
  const { monitor, notifications, failures } = makeMonitor();
  monitor.handle(event('UserPromptSubmit', 100));
  monitor.handle(event('StopFailure', 120));
  monitor.handle(event('StopFailure', 120));
  await wait(15);
  assert.equal(monitor.get('session-1').status, 'failed');
  assert.equal(notifications.length, 0);
  assert.equal(failures.length, 1);
});

test('TaskCompleted 和重复 Stop 都不会跨越主轮次边界或重复提醒', async () => {
  const idle = makeMonitor();
  idle.monitor.handle(event('TaskCreated', 100, { task_id: 'task-1' }));
  idle.monitor.handle(event('TaskCompleted', 110, { task_id: 'task-1' }));
  await wait(15);
  assert.equal(idle.monitor.get('session-1').status, 'idle');
  assert.equal(idle.notifications.length, 0);

  const repeated = makeMonitor();
  repeated.monitor.handle(event('UserPromptSubmit', 100));
  repeated.monitor.handle(event('Stop', 120));
  repeated.monitor.handle(event('Stop', 120));
  await wait(15);
  assert.equal(repeated.notifications.length, 1);
});

test('同一逻辑回合的不同 Stop 事件也只发送一次完成提醒', async () => {
  const { monitor, notifications } = makeMonitor();
  monitor.handle(event('UserPromptSubmit', 100));
  monitor.handle(event('Stop', 120, { event_id: 'stop-first' }));
  await wait(15);
  monitor.handle(event('Stop', 130, { event_id: 'stop-retry' }));
  await wait(15);
  assert.equal(notifications.length, 1);
});

test('启动时 replay 的历史完成状态只建立 baseline，不发送提醒', async () => {
  const saved = new Map();
  const { monitor, notifications } = makeMonitor({
    loadLastNotifiedCompletionId: (sessionId) => saved.get(sessionId) || '',
    saveLastNotifiedCompletionId: (sessionId, completionId) => saved.set(sessionId, completionId),
  });
  monitor.handleBatch([
    event('UserPromptSubmit', 100),
    event('Stop', 120),
  ], { baseline: true });
  assert.equal(monitor.get('session-1').status, 'completed');
  assert.equal(notifications.length, 0);
  assert.ok(saved.get('session-1'));
  await wait(15);
});

test('启动时 replay 的 pending Stop 在稍后清空工具后仍不会发送历史提醒', async () => {
  const { monitor, notifications } = makeMonitor();
  monitor.handleBatch([
    event('UserPromptSubmit', 100),
    event('PreToolUse', 110, { tool_use_id: 'historical-tool' }),
    event('Stop', 120),
  ], { baseline: true });
  assert.equal(monitor.get('session-1').pendingCompletion, true);
  monitor.handle(event('PostToolUse', 130, { tool_use_id: 'historical-tool' }));
  await wait(15);
  assert.equal(monitor.get('session-1').status, 'completed');
  assert.equal(notifications.length, 0);
});

test('新一轮 Prompt 会重新生成 completionId 并再次提醒', async () => {
  const { monitor, notifications } = makeMonitor();
  monitor.handle(event('UserPromptSubmit', 100));
  monitor.handle(event('Stop', 120));
  await wait(15);
  monitor.handle(event('UserPromptSubmit', 200));
  monitor.handle(event('Stop', 220));
  await wait(15);
  assert.equal(notifications.length, 2);
  assert.notEqual(notifications[0].completionId, notifications[1].completionId);
});

test('Stop 后稳定窗口内出现新活动会取消 pending completion', async () => {
  const { monitor, notifications } = makeMonitor({ stabilizationMs: 15 });
  monitor.handle(event('UserPromptSubmit', 100));
  monitor.handle(event('Stop', 120));
  await wait(3);
  monitor.handle(event('PreToolUse', 130, { tool_use_id: 'tool-after-stop' }));
  await wait(25);
  assert.equal(monitor.get('session-1').pendingCompletion, false);
  assert.notEqual(monitor.get('session-1').status, 'completed');
  assert.equal(notifications.length, 0);
});

test('缺少 session_id 或当前轮次的 Stop 只记录诊断，不完成也不提醒', async () => {
  const { monitor, notifications, diagnostics } = makeMonitor();
  monitor.handle({ event: 'Stop', ts: 100, session_id: null });
  monitor.handle(event('Stop', 110));
  await wait(15);
  assert.equal(monitor.get('session-1').status, 'idle');
  assert.equal(notifications.length, 0);
  assert.ok(Array.isArray(diagnostics));
});

test('失败事件可以独立排出，不能被完成事件队列吞掉', () => {
  const monitor = makeMonitor().monitor;
  monitor.handle(event('SessionStart', 1));
  monitor.handle(event('UserPromptSubmit', 2));
  monitor.handle(event('StopFailure', 3));
  assert.equal(monitor.drainNotifications().length, 0);
  assert.equal(monitor.drainFailures().length, 1);
  assert.equal(monitor.drainFailures().length, 0);
});

test('运行状态超过 TTL 只回落为 unknown，不把静默误报成 completed', () => {
  let now = 1_000;
  const diagnostics = [];
  const monitor = createWorkBuddyMonitor({
    clock: () => now,
    staleThresholds: { thinking: 10 },
    onDiagnostic: (event) => diagnostics.push(event),
  });
  monitor.handle(event('UserPromptSubmit', now));
  now += 11;
  monitor.reconcileStale();
  assert.equal(monitor.get('session-1').status, 'unknown');
  assert.equal(monitor.drainNotifications().length, 0);
  assert.equal(diagnostics.at(-1).diagnostic, 'stale-runtime');
});

test('SessionEnd 不会把已经确认的 completed 状态重置成 idle', async () => {
  const monitor = makeMonitor().monitor;
  monitor.handle(event('UserPromptSubmit', 1));
  monitor.handle(event('Stop', 2));
  await wait(15);
  monitor.handle(event('SessionEnd', 3));
  assert.equal(monitor.get('session-1').status, 'completed');
});
