'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

function loadSessionNavigationId() {
  const start = app.indexOf('function sessionNavigationId(');
  const end = app.indexOf('\nfunction jumpToAgentSession(', start);
  assert.ok(start >= 0 && end > start);
  return vm.runInNewContext(`${app.slice(start, end)}\nsessionNavigationId`);
}

test('Marvis session 卡片跳转调用指定会话接口', () => {
  assert.match(app, /function openMarvisSession\(sessionId\)/);
  assert.match(app, /function jumpToAgentSession\(s\)[\s\S]*?s\.agent === 'marvis'[\s\S]*?openMarvisSession\(s\.session_id\)/);
  assert.match(app, /function sessionNavigationId\(s\)/);
});

test('Marvis synthetic child jump uses durable parent while preserving child card identity', () => {
  assert.match(app, /const navigationId = sessionNavigationId\(s\)/);
  assert.match(app, /s = \{ \.\.\.s, session_id: navigationId \}/);
});

test('Marvis synthetic child navigation resolves the durable conversation parent', () => {
  const sessionNavigationId = loadSessionNavigationId();
  const child = {
    agent: 'marvis', session_role: 'child', session_id: 'conv:subagent:sa-1',
    parent_session_ref: 'marvis:conv',
  };
  assert.equal(sessionNavigationId(child), 'conv');
  assert.equal(child.session_id, 'conv:subagent:sa-1');
  assert.equal(sessionNavigationId({ ...child, parent_session_ref: 'hermes:conv' }), child.session_id);
  assert.equal(sessionNavigationId({ ...child, parent_session_ref: null }), child.session_id);
});

test('后端 Marvis 跳转接口构造 conversation share 深链并校验存储会话', () => {
  assert.match(server, /require\('\.\/lib\/marvis-deep-link'\)/);
  assert.match(server, /require\('\.\/lib\/marvis-desktop-path'\)/);
  assert.match(server, /\/api\/open-marvis-session/);
  assert.match(server, /buildMarvisDeepLink\(sessionId\)/);
  assert.match(server, /store\.getSession\(`marvis:\$\{sessionId\}`\)/);
  assert.match(server, /resolveMarvisMain\(\)/);
  assert.match(server, /ensureAppThenDeepLink/);
  assert.match(server, /launchDetachedTargetPromise\(launcher, \[deepLink\]\)/);
});

test('Marvis session 跳转不再退回通用启动应用分支', () => {
  assert.match(app, /s\.agent === 'marvis'[\s\S]*?return openMarvisSession\(s\.session_id\)/);
});
