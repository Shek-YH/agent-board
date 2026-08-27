'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

test('后台扫描不会把正常后端状态显示成异常状态', () => {
  assert.match(source, /后端正常 · \$\{available\} 个数据源\$\{data\.scanning \? ' · 后台扫描中' : ''\}/);
  assert.doesNotMatch(source, /setRuntimeHealth\(data\.scanning \?/);
});
