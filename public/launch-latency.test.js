'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('启动和深链接口先返回已投递，再在后台验证窗口', () => {
  assert.match(server, /verification: 'pending'/);
  assert.match(server, /setTimeout\(\(\) => verifyAgentWindow\(/);
  assert.doesNotMatch(server, /windowVerified = await waitForAppWindow\(procName, 9000\)/);
  assert.doesNotMatch(server, /setTimeout\(\(\) => \{\s*focusAppCall\(def\.proc/);
});

test('有协议或启动脚本的顶栏入口不等待 PowerShell 窗口探测', () => {
  const start = server.indexOf('function launchOrFocusRaw');
  const end = server.indexOf('// spawn/cmd start 返回成功', start);
  const raw = server.slice(start, end);
  assert.match(raw, /if \(def\.scheme\)[\s\S]*?launchSchemeTarget\(def\.scheme/);
  assert.match(raw, /if \(def\.launch\)[\s\S]*?launchDetachedTarget\(p/);
});
