'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const normalizedApp = app.replace(/\r\n/g, '\n');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('ZCode session 卡片跳转调用专用 session 接口', () => {
  assert.match(app, /function openZCodeSession\(sessionId\)/);
  assert.match(app, /function jumpToAgentSession\(s\)[\s\S]*?s\.agent === 'zcode'[\s\S]*?openZCodeSession\(s\.session_id\)/);
});

test('后端 ZCode 跳转先打开 session 所在工作区，再精确定位任务', () => {
  const start = server.indexOf("if (pathname === '/api/open-zcode-session'");
  const end = server.indexOf("// 按 sessionId 打开已安装的 DeepSeek", start);
  const route = server.slice(start, end);
  assert.match(route, /store\.getSession\(`zcode:\$\{sessionId\}`\)/);
  assert.match(route, /await launchZCodeWorkspace\(workspace\)/);
  assert.match(route, /await focusZCodeSessionWithUiAutomation\(\{[\s\S]*?sessionId[\s\S]*?title: session\.title[\s\S]*?cwd: workspace/);
  assert.match(server, /async function launchZCodeWorkspace\(workspace\)[\s\S]*?resolveAgentGuiExecutable\('zcode'\)/);
  assert.match(server, /async function launchZCodeWorkspace\(workspace\)[\s\S]*?'--open-workspace', workspace/);
  assert.match(server, /async function launchZCodeWorkspace\(workspace\)[\s\S]*?waitForAppWindow\('ZCode', 9000\)/);
  assert.doesNotMatch(route, /ensureAppThenDeepLink/);
  assert.match(route, /focus\.status === 'ok'/);
});

test('ZCode session 跳转不再退回只激活应用的通用 launchAgent', () => {
  const start = normalizedApp.indexOf('function jumpToAgentSession(s)');
  const end = normalizedApp.indexOf('\nasync function refreshRunStatus', start);
  const jump = normalizedApp.slice(start, end);
  assert.ok(start >= 0 && end > start, '未找到 session 跳转函数');
  assert.match(jump, /s\.agent === 'zcode'[\s\S]*?openZCodeSession\(s\.session_id\)/);
  const zcodeBranch = jump.match(/if \(s\.agent === 'zcode'\)[^\n]*/)?.[0] || '';
  assert.doesNotMatch(zcodeBranch, /launchAgent\(s\.agent\)/);
});
