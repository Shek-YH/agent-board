'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createCodexSessionProvisioner, provisionSession } = require('./session-provisioner');

const THREAD_ID = '11111111-1111-4111-8111-111111111111';
const UUID_V7_THREAD_ID = '01a058a0-fd5c-7151-a274-7ada8e001ae5';

test('Codex provisioner creates a real thread with the selected project cwd and no task message', async () => {
  const calls = [];
  const provisioner = createCodexSessionProvisioner({
    request: async (method, params) => {
      calls.push({ method, params });
      return { thread: { id: THREAD_ID } };
    },
  });
  const session = await provisioner.create({ projectPath: 'C:\\work\\app' });
  assert.deepEqual(calls, [{ method: 'thread/start', params: { cwd: 'C:\\work\\app' } }]);
  assert.deepEqual(session, {
    sessionRef: `codex:${THREAD_ID}`, agent: 'codex', projectPath: 'C:\\work\\app', transport: 'codex-app-server',
  });
});

test('Codex provisioner accepts the UUID v7 thread IDs returned by current Codex', async () => {
  const provisioner = createCodexSessionProvisioner({
    request: async () => ({ thread: { id: UUID_V7_THREAD_ID } }),
  });

  const session = await provisioner.create({ projectPath: 'C:\\work\\app' });

  assert.equal(session.sessionRef, `codex:${UUID_V7_THREAD_ID}`);
});

test('Codex provisioner names the real thread so Codex Desktop can index it', async () => {
  const calls = [];
  const provisioner = createCodexSessionProvisioner({
    request: async (method, params) => {
      calls.push({ method, params });
      return { thread: { id: THREAD_ID } };
    },
  });

  await provisioner.create({ projectPath: 'C:\\work\\app', title: '查询广州明天天气' });

  assert.deepEqual(calls, [
    { method: 'thread/start', params: { cwd: 'C:\\work\\app' } },
    { method: 'thread/name/set', params: { threadId: THREAD_ID, name: '查询广州明天天气' } },
  ]);
});

test('Codex provisioner sends the first instruction through the same app-server thread', async () => {
  const calls = [];
  const provisioner = createCodexSessionProvisioner({
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === 'thread/start') return { thread: { id: THREAD_ID } };
      return { turn: { id: UUID_V7_THREAD_ID, status: 'inProgress' } };
    },
  });

  const session = await provisioner.create({ projectPath: 'C:\\work\\app' });
  const result = await provisioner.startTurn({
    sessionRef: session.sessionRef,
    message: '请检查项目并完成任务',
  });

  assert.deepEqual(calls, [
    { method: 'thread/start', params: { cwd: 'C:\\work\\app' } },
    {
      method: 'turn/start',
      params: {
        threadId: THREAD_ID,
        input: [{ type: 'text', text: '请检查项目并完成任务' }],
      },
    },
  ]);
  assert.equal(result.turnId, UUID_V7_THREAD_ID);
  assert.equal(result.status, 'inProgress');
});

test('Codex provisioner returns immediately after an in-progress turn starts and keeps the app-server alive', async () => {
  const calls = [];
  let closeCount = 0;
  const provisioner = createCodexSessionProvisioner({
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === 'thread/start') return { thread: { id: THREAD_ID } };
      return { turn: { id: UUID_V7_THREAD_ID, status: 'inProgress' } };
    },
    waitForNotification: async () => { throw new Error('should not wait for turn/completed'); },
    close: async () => { closeCount++; },
  });

  const session = await provisioner.create({ projectPath: 'C:\\work\\app' });
  const result = await provisioner.startTurn({ sessionRef: session.sessionRef, message: '请完成任务' });

  // 接受即返回：不等待 turn/completed 通知，inProgress 时保留 app-server 让回合继续执行。
  assert.equal(result.ok, true);
  assert.equal(result.status, 'inProgress');
  assert.equal(closeCount, 0); // 未被释放（回合仍要执行）
  assert.deepEqual(calls.map((call) => call.method), ['thread/start', 'turn/start']);
});

test('Codex provisioner releases the creation lock and resumes the thread before its first turn', async () => {
  const calls = [];
  let closeCount = 0;
  const provisioner = createCodexSessionProvisioner({
    releaseAfterCreate: true,
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === 'thread/start') return { thread: { id: THREAD_ID } };
      if (method === 'thread/resume') return { thread: { id: THREAD_ID } };
      return { turn: { id: UUID_V7_THREAD_ID, status: 'completed' } };
    },
    close: async () => { closeCount++; },
  });

  const session = await provisioner.create({ projectPath: 'C:\\work\\app' });
  assert.equal(closeCount, 1);

  const result = await provisioner.startTurn({ sessionRef: session.sessionRef, message: '请完成任务' });

  assert.equal(result.status, 'completed');
  assert.equal(closeCount, 2);
  assert.deepEqual(calls.map((call) => call.method), ['thread/start', 'thread/resume', 'turn/start']);
  assert.deepEqual(calls[1].params, { threadId: THREAD_ID });
});

test('Codex provisioner does not hang on a missing turn/completed notification and still releases the writer lock', async () => {
  const calls = [];
  let closeCount = 0;
  const provisioner = createCodexSessionProvisioner({
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === 'thread/start') return { thread: { id: THREAD_ID } };
      return { turn: { id: UUID_V7_THREAD_ID, status: 'inProgress' } };
    },
    // 模拟「回合已完成但 turn/completed 通知缺失/超时」。
    waitForNotification: async () => { const error = new Error('APP_SERVER_NOTIFICATION_TIMEOUT'); throw error; },
    close: async () => { closeCount++; },
  });

  const session = await provisioner.create({ projectPath: 'C:\\work\\app' });
  const result = await provisioner.startTurn({ sessionRef: session.sessionRef, message: '请完成任务' });

  // 接受即返回：即使 turn/completed 通知缺失/超时，也不抛错、不死等；inProgress 时保留
  // app-server 让回合继续执行（回合完成由会话文件回复检测驱动）。
  assert.equal(result.ok, true);
  assert.equal(result.status, 'inProgress');
  assert.equal(closeCount, 0);
  assert.deepEqual(calls.map((call) => call.method), ['thread/start', 'turn/start']);
});

test('unsupported Agent provisioning fails closed instead of synthesizing a Session', async () => {
  await assert.rejects(
    () => provisionSession({ agent: 'claude', projectPath: 'C:\\work\\app', provisioners: {} }),
    (error) => error.code === 'SESSION_CREATION_UNAVAILABLE',
  );
});
