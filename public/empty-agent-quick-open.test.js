'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const renderBoard = app.slice(app.indexOf('function renderBoard'), app.indexOf('function setHoveredColumn'));

test('无 session 的具体 Agent 列显示快速打开按钮', () => {
  assert.match(renderBoard, /if \(!list\.length\) \{[\s\S]*?key !== 'all'[\s\S]*?col-empty-action/);
  assert.match(renderBoard, /className = 'col-empty-action'/);
});

test('空态快速打开按钮只启动 Agent，不跳转 session', () => {
  assert.match(renderBoard, /col-empty-action[\s\S]*?addEventListener\('click', \(e\) => \{[\s\S]*?launchAgent\(key\)/);
  assert.doesNotMatch(renderBoard, /col-empty-action[\s\S]*?jumpToAgentSession/);
});
