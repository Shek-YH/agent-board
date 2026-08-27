'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

test('较长 session ID 的可见标签会统一截断，避免挤压状态标签造成卡片变高', () => {
  assert.match(app, /function displaySessionId\(sessionId\)\s*\{/);
  assert.match(app, /const sessionIdLabel = displaySessionId\(sessionId\)/);
  assert.match(app, /value\.length > 16/);
  assert.match(app, /value\.slice\(0, 8\).*value\.slice\(-5\)/s);
  assert.match(app, /esc\(sessionIdLabel\)/);
});

test('session 卡将时间和 session ID 放在底部，并为标题保留多行空间', () => {
  const cardTemplate = app.match(/function buildCard[\s\S]*?card\.innerHTML = `([\s\S]*?)`;\n/);
  assert.ok(cardTemplate, '未找到 session 卡片模板');
  const template = cardTemplate[1];
  const firstRow = template.match(/<div class="s-row1">([\s\S]*?)<\/div>/)?.[1] || '';
  const bottomRow = template.match(/<div class="s-row2">([\s\S]*?)<\/div>/)?.[1] || '';
  assert.doesNotMatch(firstRow, /s-time|sessionIdHtml/);
  assert.match(bottomRow, /s-time/);
  assert.match(bottomRow, /sessionIdHtml/);
  assert.match(template, /<div class="s-title-row">[\s\S]*?titleHtml[\s\S]*?statusHtml/);
  assert.match(html, /\.s-title\{[^}]*white-space:normal[^}]*-webkit-line-clamp:2/);
  assert.match(html, /\.board\.has-focus \.agent-col\.focused \.s-card\{[^}]*min-height:154px/);
});
