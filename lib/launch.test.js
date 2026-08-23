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
