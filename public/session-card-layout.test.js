'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8').replace(/\r\n/g, '\n');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8').replace(/\r\n/g, '\n');

test('较长 session ID 的可见标签会统一截断，避免挤压状态标签造成卡片变高', () => {
  assert.match(app, /function displaySessionId\(sessionId\)\s*\{/);
  assert.match(app, /const sessionIdLabel = displaySessionId\(sessionId\)/);
  assert.match(app, /value\.length > 16/);
  assert.match(app, /value\.slice\(0, 8\).*value\.slice\(-5\)/s);
  assert.match(app, /esc\(sessionIdLabel\)/);
});

test('session 卡将状态与主会话放在顶部，并为标题保留多行空间', () => {
  const cardTemplate = app.match(/function buildCard[\s\S]*?card\.innerHTML = `([\s\S]*?)`;\r?\n/);
  assert.ok(cardTemplate, '未找到 session 卡片模板');
  const template = cardTemplate[1];
  const firstRow = template.match(/<div class="s-row1">([\s\S]*?)<\/div>/)?.[1] || '';
  const titleRow = template.match(/<div class="s-title-row">([\s\S]*?)<\/div>/)?.[1] || '';
  const bottomRow = template.match(/<div class="s-row2">([\s\S]*?)<\/div>/)?.[1] || '';
  assert.doesNotMatch(firstRow, /s-time|sessionIdHtml/);
  assert.match(app, /function topologyRoleMarkup\(s, statusHtml = ''\)[\s\S]*?return badge \+ statusHtml \+ relation;/);
  assert.match(firstRow, /topologyRoleMarkup\(s, statusHtml\)/);
  assert.match(firstRow, /autopilotButton/);
  assert.doesNotMatch(titleRow, /statusHtml|autopilotButton/);
  assert.match(bottomRow, /s-time/);
  assert.match(bottomRow, /sessionIdHtml/);
  assert.match(titleRow, /titleHtml/);
  assert.match(html, /\.s-title\{[^}]*white-space:normal[^}]*-webkit-line-clamp:2/);
  assert.match(html, /\.app\{[^}]*width:100%[^}]*max-width:none[^}]*margin:0/);
  assert.match(html, /\.board-layout\{[^}]*grid-template-columns:166px minmax\(0,1fr\)[^}]*gap:10px/);
  assert.match(html, /\.board\{[^}]*display:grid[^}]*grid-auto-flow:column[^}]*grid-auto-columns:max\(180px,calc\(\(100% - 50px\)\/6\)\)[^}]*overflow-x:auto/);
  assert.doesNotMatch(html, /grid-template-columns:repeat\(auto-fit/);
  assert.match(html, /\.s-card\{[^}]*height:196px[^}]*min-height:196px/);
  assert.match(html, /\.s-actions\{[^}]*position:absolute[^}]*right:12px[^}]*bottom:12px/);
  assert.match(html, /\.s-row1\{[^}]*flex-wrap:nowrap[^}]*min-width:0[^}]*overflow:hidden/);
  assert.match(html, /\.s-row1>\.s-status\{[^}]*flex:0 0 auto/);
  assert.match(html, /\.s-row1>\.s-autopilot\{[^}]*margin-left:auto[^}]*flex:0 0 auto/);
});

test('流光状态不会将 session 操作区挤回内容流', () => {
  assert.match(html, /\.s-card\.flow-red>:not\(\.s-actions\),\.s-card\.flow-green>:not\(\.s-actions\)\{[^}]*position:relative[^}]*z-index:1/);
  assert.match(html, /\.s-actions\{[^}]*position:absolute[^}]*right:12px[^}]*bottom:12px[^}]*z-index:3/);
});

test('session 看板按 Agent 分列渲染，未来新增列不会和现有 session 混成全局矩阵', () => {
  assert.match(app, /for \(const key of cols\) \{[\s\S]*?col\.className = 'agent-col'[\s\S]*?const list = state\.board\[key\] \|\| \[\][\s\S]*?buildCard\(s, key\)/);
  assert.match(html, /\.board\{[^}]*grid-auto-flow:column[^}]*grid-template-rows:auto/);
});
