'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

test('会话卡悬停时聚焦列，列内间隙保持展开，离列后恢复等宽布局', () => {
  assert.match(app, /function setHoveredColumn\(key\)/);
  assert.match(app, /function clearHoveredColumn\(\)/);
  assert.match(app, /col\.addEventListener\('mouseenter', \(\) => setHoveredColumn\(key\)\)/);
  assert.match(app, /col\.addEventListener\('mouseleave', \(\) => clearHoveredColumn\(\)\);/);
  assert.doesNotMatch(app, /card\.addEventListener\('mouseenter'/);
  assert.doesNotMatch(app, /card\.addEventListener\('mouseleave'/);
  assert.match(app, /if \(board\.dataset\.hoveredCol === key\) return;/);
  assert.doesNotMatch(app, /function toggleFocus\(/);
 assert.match(html, /\.board\{[^}]*transition:grid-template-columns \.2s ease[^}]*\}/);
 });

test('刷新重建看板时保留仍在悬停列内的聚焦状态', () => {
  assert.match(app, /const hoveredCol = board\.dataset\.hoveredCol;/);
  assert.match(app, /const preserveFocus = hoveredCol && cols\.includes\(hoveredCol\)/);
  assert.match(app, /\.agent-col.*matches\(':hover'\)/s);
  assert.match(app, /if \(preserveFocus\) \{/);
});
