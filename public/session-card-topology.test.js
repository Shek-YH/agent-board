'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const appSource = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const htmlSource = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

test('session cards render explicit topology badges and relationships', () => {
  assert.match(appSource, /◎ 主会话/);
  assert.match(appSource, /↳ 子代理/);
  assert.match(appSource, /\? 未确认/);
  assert.match(appSource, /parent_session_ref/);
  assert.match(appSource, /child_count/);
  assert.match(appSource, /topology-\$\{topologyRole\}/);
  assert.match(appSource, /card\.dataset\.topologyRole = topologyRole/);
});

test('project labels use the final path segment while retaining the full title', () => {
  assert.match(appSource, /function shortProj\(p\)/);
  assert.equal(appSource.includes('const parts = trimmed.split(/[\\\\/]/).filter(Boolean);'), true);
  assert.match(appSource, /class="s-proj" title="\$\{esc\(s\.project\)\}"/);
});

test('topology badge styles are compact and accessible by text, not color alone', () => {
  assert.match(htmlSource, /\.s-topology-badge\.main/);
  assert.match(htmlSource, /\.s-topology-badge\.child/);
  assert.match(htmlSource, /\.s-topology-badge\.unknown/);
});
