'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const desktopPath = fs.readFileSync(path.join(__dirname, '..', 'lib', 'hermes-desktop-path.js'), 'utf8');

test('Hermes session 卡片跳转调用桌面端指定 stored session 接口', () => {
  assert.match(app, /function openHermesSession\(sessionId\)/);
  assert.match(app, /function jumpToAgentSession\(s\)[\s\S]*?s\.agent === 'hermes'[\s\S]*?openHermesSession\(s\.session_id\)/);
});

test('后端 Hermes 跳转接口只接受 sessionId 并构造 hermes 深链', () => {
  assert.match(server, /\/api\/open-hermes-session/);
  assert.match(server, /buildHermesDesktopDeepLink\(sessionId\)/);
  assert.doesNotMatch(server, /body\.url/);
});

test('Hermes 顶栏启动不依赖未注册的 hermes 协议', () => {
  assert.match(
    server,
    /if \(agent === 'hermes'\)[\s\S]*?resolveHermesDesktopExe\(\)[\s\S]*?spawn\(desktopExe, \[\],/
  );
});

test('Hermes 跳转优先使用支持单实例的本地桌面构建', () => {
  assert.match(server, /require\('\.\/lib\/hermes-desktop-path'\)/);
  assert.match(server, /resolveHermesDesktopExe\(\)/);
  assert.match(desktopPath, /release', 'win-unpacked', 'Hermes\.exe'/);
});

test('Hermes session 跳转后激活 Hermes 主窗口', () => {
  assert.match(server, /function focusHermesWindow\(attempt = 0\)/);
  assert.match(server, /function focusHermesWindow\(attempt = 0\)[\s\S]*?focusAppCall\('Hermes'/);
  assert.match(server, /\/api\/open-hermes-session[\s\S]*?focusHermesWindow\(\)/);
});
