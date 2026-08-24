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
  assert.match(app, /card\.addEventListener\('mouseenter', \(\) => setHoveredColumn\(colKey\)\)/);
  assert.match(app, /col\.addEventListener\('mouseleave', \(\) => clearHoveredColumn\(\)\);/);
  assert.doesNotMatch(app, /card\.addEventListener\('mouseleave'/);
  assert.doesNotMatch(app, /function toggleFocus\(/);
  assert.match(html, /\.board\{[^}]*transition:grid-template-columns \.2s ease[^}]*\}/);
});
