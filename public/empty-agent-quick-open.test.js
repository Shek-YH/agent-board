'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const renderBoard = app.slice(app.indexOf('function renderBoard'), app.indexOf('// 隐藏一个 Agent'));

test('无 session 的 Agent 列显示独立空态，并保留该 Agent 的启动入口', () => {
  assert.match(renderBoard, /const list = state\.board\[key\] \|\| \[\]/);
  assert.match(renderBoard, /if \(!list\.length\) \{[\s\S]*?className = 'col-empty'[\s\S]*?暂无该 agent 的会话/);
  assert.match(renderBoard, /col-empty-action/);
  assert.match(renderBoard, /launchAgent\(key\)/);
});

test('全部列空态不会伪造一个不存在的 Agent 启动操作', () => {
  assert.match(renderBoard, /key !== 'all' && state\.agentsDef\[key\]/);
});
