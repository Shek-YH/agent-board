'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const renderBoard = app.slice(app.indexOf('function renderBoard'), app.indexOf('// 隐藏一个 Agent'));

test('无 session 时显示全局看板空态', () => {
  assert.match(renderBoard, /if \(!list\.length\) \{[\s\S]*?className = 'col-empty'[\s\S]*?暂无会话/);
  assert.doesNotMatch(renderBoard, /col-empty-action/);
});

test('方案一空态不创建不存在的 Agent session 跳转操作', () => {
  assert.doesNotMatch(renderBoard, /launchAgent\(key\)/);
  assert.doesNotMatch(renderBoard, /jumpToAgentSession/);
});
