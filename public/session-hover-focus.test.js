'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

test('看板按列呈现 Agent，列内卡片保持垂直瀑布流', () => {
  assert.match(app, /for \(const key of cols\) \{[\s\S]*?col\.className = 'agent-col'/);
  assert.match(app, /const list = state\.board\[key\] \|\| \[\]/);
  assert.match(app, /for \(const s of list\) cardsBox\.appendChild\(buildCard\(s, key\)\)/);
  assert.match(html, /\.board\{[^}]*grid-auto-flow:column[^}]*grid-auto-columns:max\(180px,calc\(\(100% - 50px\)\/6\)\)/);
  assert.match(html, /\.board\{[^}]*overflow-x:auto/);
 });
