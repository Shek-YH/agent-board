'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const index = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

test('全部视图的 Agent 标签和 session 标题共用显式的标题行，不与卡片边界重叠', () => {
  assert.match(app, /<div class="s-title-leading">\s*\$\{agentTag\}\s*\$\{titleHtml\}/);
  assert.match(app, /<div class="s-row1">\s*\$\{topologyRoleMarkup\(s\)\}/);
  assert.match(index, /\.s-title-leading\{[^}]*min-width:0/);
  assert.match(index, /\.s-title-leading \.agent-tag\{[^}]*white-space:nowrap/);
});

test('Agent 列标签固定留在 session 卡上方，不会在滚动时覆盖卡片', () => {
  assert.match(app, /col\.appendChild\(head\);\s*col\.appendChild\(cardsBox\);/);
  assert.match(index, /\.agent-col\{[^}]*display:flex[^}]*flex-direction:column/);
  assert.match(index, /\.col-head\{[^}]*position:static/);
  assert.doesNotMatch(index, /\.col-head\{[^}]*position:sticky/);
});
