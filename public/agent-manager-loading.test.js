'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

test('应用管理在首次检测和重新探测时渲染可区分的 loading 状态', () => {
  assert.match(app, /function agentManagerLoadingMarkup\(force\)/);
  assert.match(app, /正在重新探测应用状态/);
  assert.match(app, /正在检测应用状态/);
  assert.match(app, /role="status"/);
  assert.match(html, /@keyframes spin\{/);
});
