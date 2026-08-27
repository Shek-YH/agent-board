'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const normalizedServer = server.replace(/\r\n/g, '\n');

test('Claude session 卡片跳转调用按 session 定位接口，而不是只激活 Claude', () => {
  assert.match(app, /function openClaudeSession\(sessionId\)/);
  assert.match(app, /function jumpToAgentSession\(s\)[\s\S]*?s\.agent === 'claude'[\s\S]*?openClaudeSession\(s\.session_id\)/);
});

test('已完成 Session 卡中的已读按钮位于跳转按钮左侧', () => {
  const row2 = app.match(/<div class="s-row2">[\s\S]*?<\/div>`;/)?.[0];
  assert.ok(row2, '未找到 Session 卡操作区模板');
  const more = row2.indexOf('class="s-more"');
  const jump = row2.indexOf('class="s-jump"');
  const dismiss = row2.indexOf('class="s-flow-dismiss"');
  assert.ok(more >= 0 && jump >= 0, '操作区缺少更多或跳转按钮');
  assert.ok(more < dismiss && dismiss < jump, '已读按钮必须位于跳转按钮之前');
  assert.match(row2, /class="s-jump" data-action="jump-session"/);
  assert.match(app, /jump\.insertAdjacentElement\('beforebegin', btn\)/, '动态补入的已读按钮必须位于跳转按钮之前');
});

test('Claude 精确跳转不再叠加通用前台激活和重试链', () => {
  const startMarker = "if (pathname === '/api/open-claude-session' && req.method === 'POST') {";
  const endMarker = '\n\n  // 按 sessionId 打开已安装的 DeepSeek Harness Desktop';
  const start = normalizedServer.indexOf(startMarker);
  const end = start >= 0 ? normalizedServer.indexOf(endMarker, start) : -1;
  const route = start >= 0 && end >= 0 ? normalizedServer.slice(start, end) : null;
  assert.ok(route, '未找到 Claude 跳转路由');
  assert.match(route, /isClaudeDesktopRunning\(\)/);
  assert.doesNotMatch(route, /focusClaudeWindow(Result)?\(\)/, 'Claude 精确跳转不能再调用通用前台激活器');
  assert.doesNotMatch(route, /setTimeout\(\(\) => focusClaudeWindow\(\)/, 'Claude 跳转不能留下延迟前台重试');
});

test('后端 Claude 跳转接口解析 Desktop descriptor 并调用 Claude launcher', () => {
  assert.match(server, /\/api\/open-claude-session/);
  assert.match(server, /resolveClaudeSessionTarget\(/);
  assert.match(server, /target\.title\s*\|\|=\s*session\.title/);
  assert.match(server, /resolveClaudeDesktopExe\(\)/);
  assert.doesNotMatch(server, /launchGuiViaShell\(claudeDesktopExe\)/);
  assert.match(server, /launchClaudeDeepLink\(target\.deepLink\)/);
  assert.doesNotMatch(server, /body\.url/);
});

test('已有 Desktop session 的 resume 和 focus 都走 UIA fallback，不退回错误会话', () => {
  assert.match(server, /if \(target\.desktopSessionId && process\.platform === 'win32'\)[\s\S]*?focusClaudeSessionWithUiAutomation\(target\)/);
  assert.match(server, /target\.origin === 'desktop'[\s\S]*?setTimeout\(\(\) => \{[\s\S]*?focusClaudeSessionWithUiAutomation\(target\)/);
  assert.match(server, /Desktop-native 失败时绝不改用 resume/);
});

test('已有 Claude Desktop 进程时，Desktop-native session 不重复发起 deep link', () => {
  assert.match(server, /isClaudeDesktopRunning\(\)/);
  assert.match(server, /target\.origin === 'desktop'[\s\S]*?process\.platform === 'win32'/);
  assert.match(server, /claudeAlreadyRunning/);
  assert.doesNotMatch(server, /claudeAlreadyRunning \? 0 : 900/);
  assert.doesNotMatch(server, /await new Promise\(\(resolve\) => setTimeout\(resolve, 900\)\)/);
});

test('导入 CLI session 仍由 session 按钮打开 Claude Desktop，不自动回退 CLI', () => {
  const start = app.indexOf('async function openClaudeSession');
  const end = app.indexOf('async function openDeepSeekSession');
  const openClaude = app.slice(start, end);
  assert.ok(start >= 0 && end > start, '未找到 Claude session 打开函数');
  assert.match(server, /导入的 CLI session 仍然先打开 Claude Desktop 的 resume 深链/);
  assert.match(server, /else \{[\s\S]*?setTimeout\(\(\) => \{[\s\S]*?focusClaudeSessionWithUiAutomation\(target\)/);
  assert.doesNotMatch(server, /recovery: \{ kind: 'cli-resume'/);
  assert.doesNotMatch(openClaude, /d\.recovery\?\.kind === 'cli-resume'/);
  assert.doesNotMatch(openClaude, /fetch\('\/api\/open-with'/);
});
