'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('DeepSeek session 卡片跳转调用桌面端指定 session 接口', () => {
  assert.match(app, /function openDeepSeekSession\(sessionId\)/);
  assert.match(app, /function jumpToAgentSession\(s\)[\s\S]*?s\.agent === 'deepseek'[\s\S]*?openDeepSeekSession\(s\.session_id\)/);
});

test('后端 DeepSeek 跳转接口只接受 sessionId 并构造 dshdesktop 深链', () => {
  assert.match(server, /\/api\/open-deepseek-session/);
  assert.match(server, /buildDeepSeekDesktopDeepLink\(sessionId\)/);
  assert.doesNotMatch(server, /body\.url/);
});
