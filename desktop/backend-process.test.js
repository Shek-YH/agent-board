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
