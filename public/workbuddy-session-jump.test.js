'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('WorkBuddy session 卡片跳转调用指定会话接口', () => {
  assert.match(app, /function openWorkBuddySession\(sessionId\)/);
  assert.match(app, /function jumpToAgentSession\(s\)[\s\S]*?s\.agent === 'workbuddy'[\s\S]*?openWorkBuddySession\(s\.session_id\)/);
});

test('后端 WorkBuddy 跳转接口构造 chat 会话深链并校验存储会话', () => {
  assert.match(server, /\/api\/open-workbuddy-session/);
  assert.match(server, /buildWorkBuddyDeepLink\(sessionId\)/);
  assert.match(server, /store\.getSession\(`workbuddy:\$\{sessionId\}`\)/);
  assert.match(server, /spawn\('cmd\.exe', \['\/c', 'start', '', deepLink\]/);
});
