'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

test('项目侧栏按最近会话排序，点击可筛选并可取消', () => {
  assert.match(app, /function projectItems\(\)/);
  assert.match(app, /sort\(\(a, b\) => \(b\.lastSeen \|\| 0\) - \(a\.lastSeen \|\| 0\)\)/);
  assert.match(app, /function toggleProject\(project\)/);
  assert.match(app, /state\.project = state\.project === project \? '' : project/);
  assert.match(app, /function projectLeaf\(project\)/);
  assert.match(app, /for \(const s of state\.board\.all \|\| \[\]\)/);
});

test('项目侧栏仅浮层展示当前悬停路径，不改变列表布局', () => {
  assert.match(html, /<div class="board-layout" id="board-layout">\s*<aside class="project-rail" id="project-rail"><\/aside>\s*<div class="board" id="board"><\/div>/);
  assert.match(html, /\.project-path\{[^}]*position:relative[^}]*\}/);
  assert.match(html, /\.project-path-full\{[^}]*position:absolute[^}]*overflow-wrap:anywhere[^}]*pointer-events:none[^}]*\}/);
  assert.match(html, /\.project-path:hover \.project-path-full\{display:block\}/);
  assert.doesNotMatch(html, /\.project-rail:hover \.project-path-full/);
  assert.match(app, /function renderProjectRail\(\)/);
  assert.match(app, /project-path-full/);
  assert.doesNotMatch(html, /<select id="f-project">/);
});

test('完整路径浮层左侧提供图标复制按钮，复制不触发项目筛选', () => {
  assert.match(app, /copyButton\.className = 'project-path-copy'/);
  assert.match(app, /copyButton\.addEventListener\('click', async \(e\) => \{\s*e\.stopPropagation\(\);\s*const ok = await clip\(item\.project\)/);
  assert.match(html, /\.project-path:hover \.project-path-copy\{display:inline-flex\}/);
  assert.match(html, /\.project-path-full\{[^}]*padding:8px 9px 8px 37px[^}]*\}/);
});
