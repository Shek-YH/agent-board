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

test('项目侧栏与会话瀑布流并列，悬停才展示完整路径', () => {
  assert.match(html, /<div class="board-layout" id="board-layout">\s*<aside class="project-rail" id="project-rail"><\/aside>\s*<div class="board" id="board"><\/div>/);
  assert.match(html, /\.project-rail:hover \.project-path-short\{display:none\}/);
  assert.match(html, /\.project-rail:hover \.project-path-full\{display:block\}/);
  assert.match(html, /\.project-rail:hover \.project-path-full\{[^}]*overflow-wrap:anywhere[^}]*\}/);
  assert.match(app, /function renderProjectRail\(\)/);
  assert.match(app, /project-path-full/);
  assert.doesNotMatch(html, /<select id="f-project">/);
});
