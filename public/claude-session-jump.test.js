'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('Claude session 卡片跳转调用按 session 定位接口，而不是只激活 Claude', () => {
  assert.match(app, /function openClaudeSession\(sessionId\)/);
  assert.match(app, /function jumpToAgentSession\(s\)[\s\S]*?s\.agent === 'claude'[\s\S]*?openClaudeSession\(s\.session_id\)/);
});

test('Session 卡中的第二个 button 始终是跳转按钮', () => {
  const row2 = app.match(/<div class="s-row2">[\s\S]*?<\/div>`;/)?.[0];
  assert.ok(row2, '未找到 Session 卡操作区模板');
  const more = row2.indexOf('class="s-more"');
  const jump = row2.indexOf('class="s-jump"');
  const dismiss = row2.indexOf('class="s-flow-dismiss"');
  assert.ok(more >= 0 && jump >= 0, '操作区缺少更多或跳转按钮');
  assert.ok(more < jump, '更多按钮必须位于跳转按钮之前');
  assert.ok(dismiss < 0 || more < dismiss && dismiss < jump, '已读按钮必须位于更多和跳转之间');
  assert.match(app, /insertBefore\(btn, jump\)/, '动态补入的已读按钮必须位于跳转按钮之前');
});

test('Claude 精确跳转不再叠加通用前台激活和重试链', () => {
  const route = server.match(/if \(pathname === '\/api\/open-claude-session'[\s\S]*?\n  \}\n\n  \/\/ 按 sessionId 打开已安装的 DeepSeek Harness Desktop/)?.[0];
  assert.ok(route, '未找到 Claude 跳转路由');
  assert.match(route, /isClaudeDesktopRunning\(\)/);
  assert.doesNotMatch(route, /focusClaudeWindow(Result)?\(\)/, 'Claude 精确跳转不能再调用通用前台激活器');
  assert.doesNotMatch(route, /setTimeout\(\(\) => focusClaudeWindow\(\)/, 'Claude 跳转不能留下延迟前台重试');
});

test('后端 Claude 跳转接口解析 Desktop descriptor 并调用 Claude launcher', () => {
  assert.match(server, /\/api\/open-claude-session/);
  assert.match(server, /resolveClaudeSessionTarget\(/);
  assert.match(server, /target\.title\s*\|\|=\s*session\.title/);
  assert.match(server, /launchClaudeDeepLink\(target\.deepLink\)/);
  assert.doesNotMatch(server, /body\.url/);
});

test('已有 Desktop session 的 resume 和 focus 都走 UIA fallback，不退回错误会话', () => {
  assert.match(server, /if \(target\.desktopSessionId && process\.platform === 'win32'\)[\s\S]*?focusClaudeSessionWithUiAutomation\(target\)/);
  assert.match(server, /target\.origin === 'desktop'[\s\S]*?await focusClaudeSessionWithUiAutomation\(target\)/);
  assert.match(server, /Desktop-native 失败时绝不改用 resume/);
});

test('已有 Claude Desktop 进程时，Desktop-native session 不重复发起 deep link', () => {
  assert.match(server, /isClaudeDesktopRunning\(\)/);
  assert.match(server, /target\.origin === 'desktop'[\s\S]*?process\.platform === 'win32'/);
  assert.match(server, /claudeAlreadyRunning/);
  assert.match(server, /claudeAlreadyRunning \? 0 : 900/);
});
