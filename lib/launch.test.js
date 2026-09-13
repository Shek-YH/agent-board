'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadLaunchOverrides, saveLaunchOverride, getManualDesktopOverride } = require('./launch');

test('loadLaunchOverrides 文件不存在返回空对象', () => {
  const p = path.join(os.tmpdir(), 'ab-launch-missing-' + Date.now() + '.json');
  assert.deepEqual(loadLaunchOverrides(p), {});
});

test('loadLaunchOverrides 坏 JSON 不崩溃，返回空对象', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-launch-'));
  const p = path.join(dir, 'launch-overrides.json');
  fs.writeFileSync(p, '{ not valid json');
  assert.deepEqual(loadLaunchOverrides(p), {});
});

test('loadLaunchOverrides 顶层是 JSON 数组时返回空对象', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-launch-'));
  const p = path.join(dir, 'launch-overrides.json');
  fs.writeFileSync(p, JSON.stringify(['x', 'y']));
  assert.deepEqual(loadLaunchOverrides(p), {});
});

test('loadLaunchOverrides 把旧字符串归一化为启用的手动桌面端', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-launch-'));
  const p = path.join(dir, 'launch-overrides.json');
  fs.writeFileSync(p, JSON.stringify({ pi: '"C:\\\\Pi\\\\Pi.exe"' }));
  assert.deepEqual(loadLaunchOverrides(p), {
    pi: { manualDesktop: { enabled: true, target: '"C:\\\\Pi\\\\Pi.exe"' } },
  });
});

test('loadLaunchOverrides 读取新对象并过滤坏字段', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-launch-'));
  const p = path.join(dir, 'launch-overrides.json');
  fs.writeFileSync(p, JSON.stringify({
    hermes: { manualDesktop: { enabled: false, target: 'Hermes.exe' } },
    bad: { manualDesktop: { enabled: 'yes', target: 42 } },
  }));
  assert.deepEqual(loadLaunchOverrides(p), {
    hermes: { manualDesktop: { enabled: false, target: 'Hermes.exe' } },
  });
});

test('saveLaunchOverride 取消 enabled 时保留 target，空 target 才清除', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-launch-'));
  const p = path.join(dir, 'launch-overrides.json');
  saveLaunchOverride('hermes', { enabled: true, target: 'Hermes.exe' }, p);
  assert.deepEqual(saveLaunchOverride('hermes', { enabled: false, target: 'Hermes.exe' }, p), {
    hermes: { manualDesktop: { enabled: false, target: 'Hermes.exe' } },
  });
  assert.deepEqual(saveLaunchOverride('hermes', { enabled: false, target: '' }, p), {});
});

test('getManualDesktopOverride 只在 enabled 且 target 非空时返回优先目标', () => {
  assert.deepEqual(getManualDesktopOverride({
    hermes: { manualDesktop: { enabled: true, target: 'Hermes.exe' } },
  }, 'hermes'), { enabled: true, target: 'Hermes.exe' });
  assert.equal(getManualDesktopOverride({
    hermes: { manualDesktop: { enabled: false, target: 'Hermes.exe' } },
  }, 'hermes'), null);
});

test('saveLaunchOverride 写入新 key，目录不存在会自动创建', () => {
  const dir = path.join(os.tmpdir(), 'ab-launch-new-' + Date.now());
  const p = path.join(dir, 'sub', 'launch-overrides.json');
  const out = saveLaunchOverride('pi', { enabled: true, target: 'my-launcher.exe' }, p);
  assert.deepEqual(out, { pi: { manualDesktop: { enabled: true, target: 'my-launcher.exe' } } });
  assert.deepEqual(loadLaunchOverrides(p), out);
});

test('saveLaunchOverride 保留其他 agent 的已有配置', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-launch-'));
  const p = path.join(dir, 'launch-overrides.json');
  saveLaunchOverride('pi', { enabled: true, target: 'cmd-a' }, p);
  saveLaunchOverride('codex', { enabled: false, target: 'cmd-b' }, p);
  assert.deepEqual(loadLaunchOverrides(p), {
    pi: { manualDesktop: { enabled: true, target: 'cmd-a' } },
    codex: { manualDesktop: { enabled: false, target: 'cmd-b' } },
  });
});

const { probePort, waitForPort } = require('./launch');

test('probePort 探测到真实监听中的端口返回 true', async () => {
  const net = require('net');
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    assert.equal(await probePort(port), true);
  } finally {
    server.close();
  }
});

test('probePort 探测未监听的端口返回 false（connection refused 路径）', async () => {
  // 绑一个端口再立刻关掉：关闭后这个端口在系统里几乎立刻可以复用，
  // 比硬编码一个"看起来应该没人用"的端口号更不容易在别的机器/CI 上偶发撞车
  const net = require('net');
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  assert.equal(await probePort(port), false);
});

test('probePort 连接超时（不回应也不拒绝）返回 false（timeout 路径，非 connection refused）', async () => {
  const { EventEmitter } = require('node:events');
  const socket = new EventEmitter();
  socket.setTimeout = () => {};
  socket.destroy = () => {};
  const pending = probePort(9, '127.0.0.1', 300, () => socket);
  socket.emit('timeout');
  assert.equal(await pending, false);
});

test('waitForPort 端口已经监听时立即返回 true（不用等）', async () => {
  const ok = await waitForPort(1234, '127.0.0.1', { intervalMs: 10, timeoutMs: 200, probeFn: async () => true });
  assert.equal(ok, true);
});

test('waitForPort 轮询几次后探测到监听，返回 true', async () => {
  let calls = 0;
  const probeFn = async () => { calls++; return calls >= 3; };
  const ok = await waitForPort(1234, '127.0.0.1', { intervalMs: 10, timeoutMs: 500, probeFn });
  assert.equal(ok, true);
  assert.ok(calls >= 3);
});

test('waitForPort 一直探测不到，超时后返回 false', async () => {
  const ok = await waitForPort(1234, '127.0.0.1', { intervalMs: 10, timeoutMs: 50, probeFn: async () => false });
  assert.equal(ok, false);
});
