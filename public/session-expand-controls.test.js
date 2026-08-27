'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

test('恢复按 Agent 分列的瀑布流，并保留每列独立的 session 列表', () => {
  assert.match(app, /for \(const key of cols\) \{[\s\S]*?col\.className = 'agent-col'[\s\S]*?const cardsBox = document\.createElement\('div'\)[\s\S]*?cardsBox\.className = 'col-cards'/);
  assert.match(app, /const list = state\.board\[key\] \|\| \[\]/);
  assert.match(app, /for \(const s of list\) cardsBox\.appendChild\(buildCard\(s, key\)\)/);
  assert.match(html, /\.board\{[^}]*grid-auto-flow:column[^}]*grid-template-rows:auto/);
  assert.match(html, /\.col-cards\{display:flex;flex-direction:column/);
});
