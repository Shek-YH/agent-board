'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

test('看板顶栏在隐藏会话按钮右侧提供退出入口', () => {
  const hiddenIndex = html.indexOf('id="btn-hidden"');
  const logoutIndex = html.indexOf('id="btn-logout"', hiddenIndex);
  assert.ok(hiddenIndex >= 0);
  assert.ok(logoutIndex > hiddenIndex);
  assert.match(html.slice(logoutIndex, logoutIndex + 180), />\s*退出/);
});

test('顶栏退出会清理云端登录并重新显示登录门禁', () => {
  assert.match(app, /function logoutFromBoard\(/);
  assert.match(app, /\$\('btn-logout'\)\.onclick = logoutFromBoard;/);
  assert.match(app, /await cloud\.logout\(\)/);
  assert.match(app, /showDesktopAuthenticationGate\(cloud, '已退出登录，请重新登录'\)/);
});
