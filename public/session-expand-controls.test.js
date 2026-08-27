'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

test('点击列头是默认展开方式，悬停自动展开仍可手动开启', () => {
  assert.match(app, /const AUTO_EXPAND_STORAGE_KEY = 'ab-hover-expand-v2';/);
  assert.match(app, /function loadAutoExpand\(\)/);
  assert.match(app, /return value === null \? false : value === '1';/);
  assert.match(app, /catch \{\s+return false;\s+\}/);
  assert.match(app, /autoExpandOnHover: loadAutoExpand\(\)/);
  assert.match(app, /settings-hover-expand/);
  assert.match(app, /悬停 session 卡自动展开/);
  assert.match(app, /toggle\.checked = state\.autoExpandOnHover/);
});

test('列头手动展开与悬停展开使用互斥的聚焦模式', () => {
  assert.match(app, /function toggleManualColumn\(key\)/);
  assert.match(app, /head\.addEventListener\('click', \(\) => toggleManualColumn\(key\)\)/);
  assert.match(app, /dataset\.focusMode/);
  assert.match(app, /dataset\.focusedCol/);
  assert.match(app, /state\.autoExpandOnHover/);
  assert.match(app, /if \(!state\.autoExpandOnHover \|\| board\.dataset\.focusMode === 'manual'\) return;/);
  assert.match(app, /if \(board\.dataset\.focusMode === 'manual' \|\| !board\.dataset\.hoveredCol\) return;/);
  assert.match(app, /delete board\.dataset\.hoveredCol;\s+board\.dataset\.focusedCol = key;/);
});

test('聚焦列真正展开，并且展开幅度不再使用原来的超宽比例', () => {
  assert.doesNotMatch(app, /2\.2fr/);
  assert.doesNotMatch(app, /0\.55fr/);
  assert.doesNotMatch(app, /minmax\(320px/);
  assert.match(app, /col === key \? 'minmax\(0, 2fr\)' : 'minmax\(0, 1fr\)'/);
  assert.match(html, /\.board\.has-focus \.agent-col\.focused \.s-card\{padding:16px 18px;min-height:154px\}/);
  assert.match(html, /\.board\.has-focus \.agent-col:not\(\.focused\) \.s-card\{padding:10px 12px;opacity:\.88\}/);
  assert.match(html, /\.board\{[^}]*transition:grid-template-columns \.2s ease[^}]*\}/);
});
