'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadLaunchOverrides, saveLaunchOverride } = require('./launch');

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

test('loadLaunchOverrides 过滤掉非字符串/空字符串的值', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-launch-'));
  const p = path.join(dir, 'launch-overrides.json');
  fs.writeFileSync(p, JSON.stringify({ pi: 'real-cmd', codex: 123, claude: '   ', workbuddy: null }));
  assert.deepEqual(loadLaunchOverrides(p), { pi: 'real-cmd' });
});

test('saveLaunchOverride 写入新 key，目录不存在会自动创建', () => {
  const dir = path.join(os.tmpdir(), 'ab-launch-new-' + Date.now());
  const p = path.join(dir, 'sub', 'launch-overrides.json');
  const out = saveLaunchOverride('pi', 'my-launcher.exe', p);
  assert.deepEqual(out, { pi: 'my-launcher.exe' });
  assert.deepEqual(loadLaunchOverrides(p), { pi: 'my-launcher.exe' });
});

test('saveLaunchOverride 空字符串清除已有 key', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-launch-'));
  const p = path.join(dir, 'launch-overrides.json');
  saveLaunchOverride('pi', 'cmd-a', p);
  const out = saveLaunchOverride('pi', '', p);
  assert.deepEqual(out, {});
  assert.deepEqual(loadLaunchOverrides(p), {});
});

test('saveLaunchOverride 保留其他 agent 的已有配置', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-launch-'));
  const p = path.join(dir, 'launch-overrides.json');
  saveLaunchOverride('pi', 'cmd-a', p);
  saveLaunchOverride('codex', 'cmd-b', p);
  assert.deepEqual(loadLaunchOverrides(p), { pi: 'cmd-a', codex: 'cmd-b' });
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
  // 10.255.255.1 是内网保留地址段，这台机器上大概率没有路由能到达，连接请求会被静默丢弃
  // 而不是主动拒绝——用来触发 probePort 的 socket.setTimeout 分支，而不是 error 分支。
  // 网络环境相关，理论上不是 100% 稳定，但这是触发"真·超时"路径最常见也最可靠的手法。
  assert.equal(await probePort(9, '10.255.255.1', 300), false);
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
