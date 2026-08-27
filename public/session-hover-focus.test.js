'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

test('方案一不再使用悬停聚焦列，卡片直接进入全局矩阵', () => {
  assert.match(app, /function renderBoard\(\)[\s\S]*?for \(const session of list\) board\.appendChild\(buildCard\(session, 'all'\)\)/);
  assert.doesNotMatch(app, /setHoveredColumn|clearHoveredColumn|toggleManualColumn|applyColumnFocus/);
  assert.doesNotMatch(app, /card\.addEventListener\('mouseenter'/);
  assert.doesNotMatch(app, /card\.addEventListener\('mouseleave'/);
  assert.match(html, /\.board\{[^}]*grid-template-columns:repeat\(auto-fit,minmax\(240px,1fr\)\)[^}]*gap:10px/);
 });

test('刷新重建看板时只渲染当前显示 Agent 的 session', () => {
  assert.match(app, /const visibleAgents = new Set\(cols\.filter\(\(key\) => key !== 'all'\)\)/);
  assert.match(app, /const source = Array\.isArray\(state\.board\.all\)/);
  assert.match(app, /const list = source\.filter\(\(session\) => !visibleAgents\.size \|\| visibleAgents\.has\(session\.agent\)\)/);
});
