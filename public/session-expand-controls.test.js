'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

test('方案一移除无效的列展开设置', () => {
  assert.doesNotMatch(app, /AUTO_EXPAND_STORAGE_KEY|settings-hover-expand|悬停 session 卡自动展开/);
});

test('方案一取消列聚焦展开，session 统一进入全局矩阵', () => {
  assert.match(app, /function renderBoard\(\)[\s\S]*?for \(const session of list\) board\.appendChild\(buildCard\(session, 'all'\)\)/);
  assert.doesNotMatch(app, /head\.addEventListener\('click', \(\) => toggleManualColumn\(key\)\)/);
  assert.doesNotMatch(app, /toggleManualColumn|applyColumnFocus|clearColumnFocus|setHoveredColumn/);
});

test('方案一使用全局等宽矩阵，聚焦状态不会改变卡片尺寸', () => {
  assert.doesNotMatch(app, /2\.2fr/);
  assert.doesNotMatch(app, /0\.55fr/);
  assert.doesNotMatch(app, /minmax\(320px/);
  assert.match(html, /\.board\{[^}]*display:grid[^}]*grid-template-columns:repeat\(auto-fit,minmax\(240px,1fr\)\)/);
  assert.match(html, /\.s-card\{[^}]*height:196px[^}]*min-height:196px/);
  assert.doesNotMatch(html, /\.board\.has-focus \.agent-col\.focused \.s-card\{[^}]*min-height/);
});
