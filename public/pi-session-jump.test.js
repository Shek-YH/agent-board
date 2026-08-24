'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('Pi session 卡片跳转调用桌面端指定 session 接口', () => {
  assert.match(app, /function openPiAgentSession\(sessionId\)/);
  assert.match(app, /function jumpToAgentSession\(s\)[\s\S]*?s\.agent === 'pi'[\s\S]*?openPiAgentSession\(s\.session_id\)/);
});

test('后端 Pi 跳转接口只接受 sessionId 并构造 piagent 深链', () => {
  assert.match(server, /\/api\/open-pi-agent-session/);
  assert.match(server, /buildPiAgentDesktopDeepLink\(sessionId\)/);
  assert.doesNotMatch(server, /body\.url/);
});
