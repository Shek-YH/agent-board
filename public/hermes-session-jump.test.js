'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const desktopPath = fs.readFileSync(path.join(__dirname, '..', 'lib', 'hermes-desktop-path.js'), 'utf8');

function loadSessionNavigationId() {
  const start = app.indexOf('function sessionNavigationId(');
  const end = app.indexOf('\nfunction jumpToAgentSession(', start);
  assert.ok(start >= 0 && end > start);
  return vm.runInNewContext(`${app.slice(start, end)}\nsessionNavigationId`);
}

test('Hermes session 卡片跳转调用桌面端指定 stored session 接口', () => {
  assert.match(app, /function openHermesSession\(sessionId\)/);
  assert.match(app, /function jumpToAgentSession\(s\)[\s\S]*?s\.agent === 'hermes'[\s\S]*?openHermesSession\(s\.session_id\)/);
  assert.match(app, /function sessionNavigationId\(s\)/);
});

test('Hermes synthetic child jump uses durable parent while preserving child card identity', () => {
  assert.match(app, /const navigationId = sessionNavigationId\(s\)/);
  assert.match(app, /s = \{ \.\.\.s, session_id: navigationId \}/);
});

test('Hermes synthetic child navigation resolves its durable parent session', () => {
  const sessionNavigationId = loadSessionNavigationId();
  const child = {
    agent: 'hermes', session_role: 'child', session_id: 'session:subagent:call-1:0',
    parent_session_ref: 'hermes:session',
  };
  assert.equal(sessionNavigationId(child), 'session');
  assert.equal(child.session_id, 'session:subagent:call-1:0');
  assert.equal(sessionNavigationId({ ...child, parent_session_ref: 'marvis:session' }), child.session_id);
  assert.equal(sessionNavigationId({ ...child, parent_session_ref: null }), child.session_id);
});

test('后端 Hermes 跳转接口只接受 sessionId 并构造 hermes 深链', () => {
  assert.match(server, /\/api\/open-hermes-session/);
  assert.match(server, /buildHermesDesktopDeepLink\(sessionId\)/);
  assert.doesNotMatch(server, /body\.url/);
});

test('Hermes 顶栏启动不依赖未注册的 hermes 协议', () => {
  assert.match(
    server,
    /if \(agent === 'hermes'\)[\s\S]*?resolveHermesDesktopExe\(\)[\s\S]*?launchGuiViaShell\(desktopExe\)/
  );
});

test('Hermes 跳转优先使用支持单实例的本地桌面构建', () => {
  assert.match(server, /require\('\.\/lib\/hermes-desktop-path'\)/);
  assert.match(server, /resolveHermesDesktopExe\(\)/);
  assert.match(desktopPath, /release', 'win-unpacked', 'Hermes\.exe'/);
});

test('Hermes session 跳转后激活 Hermes 主窗口', () => {
  assert.match(server, /hermes:[\s\S]*proc: 'Hermes'/, 'Hermes 必须使用实际桌面进程名，而不是 CLI 名');
  assert.match(server, /function focusHermesWindow\(attempt = 0\)/);
  assert.match(server, /function focusHermesWindow\(attempt = 0\)[\s\S]*?focusAppCall\('Hermes'/);
  assert.match(server, /function launchHermesDesktop\([\s\S]*?focusAppCall\('Hermes'/);
  assert.match(server, /function launchHermesDesktop\([\s\S]*?launchGuiViaShell\(desktopExe\)/);
  assert.match(server, /function launchHermesThenFocus\([\s\S]*?launchHermesDesktop\([\s\S]*?waitForAppWindow\('Hermes'/);
  assert.match(server, /\/api\/open-hermes-session[\s\S]*?launchHermesThenFocus\([\s\S]*?buildHermesDesktopDeepLink\(sessionId\)[\s\S]*?launchDetachedTargetPromise\(desktopExe, \[deepLink\]\)/);
});

test('Hermes 顶栏启动与 session 卡片复用同一套前台化入口', () => {
  assert.match(server, /if \(agent === 'hermes'\)\s*\{[\s\S]*?launchHermesDesktop\(cb\);/);
  assert.match(server, /function launchHermesDesktop\([\s\S]*?if \(text\.startsWith\('OK:'\)\)/);
});
