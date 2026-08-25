'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

test('应用管理提供每个 Agent 的自动配置路径按钮', () => {
  assert.match(app, /ab-discover-path/);
  assert.match(app, /discover-path/);
  assert.match(app, /自动配置路径/);
});

test('应用管理安装动作只打开官方下载链接，不执行后端安装命令', () => {
  assert.match(app, /downloadUrl/);
  assert.match(app, /window\.open\(downloadUrl/);
  assert.doesNotMatch(app, /fetch\(`\/api\/agents\/\$\{encodeURIComponent\(id\)\}\/install`/);
});
