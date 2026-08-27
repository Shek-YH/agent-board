'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const test = require('node:test');
const { buildBackendLaunch, waitForBackend, stopBackend } = require('./backend-process');

test('buildBackendLaunch 传递端口、数据目录和 desktop 标记', () => {
  const result = buildBackendLaunch({
    nodeRuntime: 'C:\\App\\resources\\runtime\\node.exe',
    backendEntry: 'C:\\App\\resources\\backend\\server.js',
    port: 49123,
    dataDir: 'D:\\AgentBoardData',
    env: { PATH: 'test-path' },
  });
  assert.equal(result.command, 'C:\\App\\resources\\runtime\\node.exe');
  assert.deepEqual(result.args, ['C:\\App\\resources\\backend\\server.js']);
  assert.equal(result.options.cwd, path.dirname(result.args[0]));
  assert.equal(result.options.windowsHide, true);
  assert.equal(result.options.env.AB_PORT, '49123');
  assert.equal(result.options.env.AB_DATA_DIR, 'D:\\AgentBoardData');
  assert.equal(result.options.env.AB_RUNTIME, 'desktop');
});

test('waitForBackend 在探测成功前轮询，成功后停止', async () => {
  let calls = 0;
  const ready = await waitForBackend(49123, {
    intervalMs: 1,
    timeoutMs: 100,
    probe: async () => ++calls >= 3,
  });
  assert.equal(ready, true);
  assert.equal(calls, 3);
});

test('waitForBackend 在后端子进程提前退出时立即失败', async () => {
  const child = new EventEmitter();
  child.exitCode = null;
  const startedAt = Date.now();
  const pending = waitForBackend(49123, {
    intervalMs: 20,
    timeoutMs: 5000,
    probe: async () => false,
    child,
  });
  setImmediate(() => child.emit('exit', 1, null));
  const ready = await pending;
  assert.equal(ready, false);
  assert.ok(Date.now() - startedAt < 1000);
});

test('waitForBackend 将预期运行身份传给探测器，避免接入旧 server', async () => {
  let received;
  const expectedRuntime = { serverEntry: 'C:\\App\\backend\\server.js', port: 49123 };
  const ready = await waitForBackend(49123, {
    intervalMs: 1,
    timeoutMs: 100,
    expectedRuntime,
    probe: async (_port, _host, runtime) => {
      received = runtime;
      return true;
    },
  });
  assert.equal(ready, true);
  assert.deepEqual(received, expectedRuntime);
});

test('stopBackend 先发送 SIGTERM 并等待子进程退出', async () => {
  class FakeChild extends EventEmitter {
    constructor() {
      super();
      this.exitCode = null;
      this.killed = false;
      this.signals = [];
    }

    kill(signal) {
      this.signals.push(signal);
      this.killed = true;
      this.exitCode = 0;
      this.emit('exit', 0, signal);
    }
  }

  const child = new FakeChild();
  await stopBackend(child, { timeoutMs: 10 });
  assert.deepEqual(child.signals, ['SIGTERM']);
});

test('Windows 停止桌面后端时清理整个进程树，避免留下聚焦子进程', async () => {
  class FakeChild extends EventEmitter {
    constructor() {
      super();
      this.pid = 4321;
      this.exitCode = null;
      this.killed = false;
      this.signals = [];
    }

    kill(signal) {
      this.signals.push(signal);
    }
  }

  const child = new FakeChild();
  let killedTreePid = null;
  const pending = stopBackend(child, {
    platform: 'win32',
    timeoutMs: 50,
    killProcessTree: async (pid) => {
      killedTreePid = pid;
      child.exitCode = 0;
      child.emit('exit', 0, null);
    },
  });

  await pending;
  assert.equal(killedTreePid, 4321);
  assert.deepEqual(child.signals, []);
});
