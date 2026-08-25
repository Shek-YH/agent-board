'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('Marvis session 卡片跳转调用指定会话接口', () => {
  assert.match(app, /function openMarvisSession\(sessionId\)/);
  assert.match(app, /function jumpToAgentSession\(s\)[\s\S]*?s\.agent === 'marvis'[\s\S]*?openMarvisSession\(s\.session_id\)/);
});

test('后端 Marvis 跳转接口构造 conversation share 深链并校验存储会话', () => {
  assert.match(server, /require\('\.\/lib\/marvis-deep-link'\)/);
  assert.match(server, /require\('\.\/lib\/marvis-desktop-path'\)/);
  assert.match(server, /\/api\/open-marvis-session/);
  assert.match(server, /buildMarvisDeepLink\(sessionId\)/);
  assert.match(server, /store\.getSession\(`marvis:\$\{sessionId\}`\)/);
  assert.match(server, /spawn\(launcher, \[deepLink\]/);
});

test('Marvis session 跳转不再退回通用启动应用分支', () => {
  assert.match(app, /s\.agent === 'marvis'[\s\S]*?return openMarvisSession\(s\.session_id\)/);
});
