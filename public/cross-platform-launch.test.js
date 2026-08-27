'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const start = fs.readFileSync(path.join(__dirname, '..', 'start.sh'), 'utf8');
const detect = fs.readFileSync(path.join(__dirname, '..', 'lib', 'detect.js'), 'utf8');

test('macOS 使用 open/osascript 启动并激活桌面 Agent', () => {
  assert.match(server, /process\.platform === 'darwin'/);
  assert.match(server, /spawnDetachedClean\('open'/);
  assert.match(server, /execFile\('osascript'/);
});

test('Session 路由不再把 WorkBuddy/Marvis/Codex 限制为 Windows', () => {
  assert.doesNotMatch(server, /当前本地 Agent 只支持 Windows Codex/);
  assert.doesNotMatch(server, /当前本地 WorkBuddy 跳转只支持 Windows/);
  assert.doesNotMatch(server, /当前本地 Marvis 跳转只支持 Windows/);
});

test('POSIX 启动脚本优先使用项目内置 runtime/node', () => {
  assert.match(start, /runtime\/node/);
  assert.match(start, /command -v node/);
  assert.match(start, /server\.js/);
});

test('Agent 探测按当前平台选择 darwin/linux 路径', () => {
  assert.match(detect, /def\.probe\[platform\]/);
  assert.match(detect, /platform === 'win32'/);
});

test('macOS 进程检查和冷启动不再硬编码 Windows tasklist/cmd.exe', () => {
  assert.match(server, /process\.platform === 'win32' \? 'tasklist' : 'ps'/);
  assert.match(server, /if \(scheme\) launchSchemeTarget\(scheme, \(\) => \{\}\)/);
  assert.match(server, /当前版本的 CLI 恢复终端仅支持 Windows/);
});
