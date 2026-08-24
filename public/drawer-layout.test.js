'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

test('抽屉消息索引隔离滚轮链并固定长列表项尺寸', () => {
  assert.match(html, /\.d-main\{[^}]*overflow:hidden[^}]*\}/);
  assert.match(html, /\.d-anchors\{[^}]*overscroll-behavior:contain[^}]*\}/);
  assert.match(html, /\.d-anchor\{[^}]*flex:none[^}]*\}/);
  assert.match(html, /\.d-round\{[^}]*flex:none[^}]*\}/);
});
