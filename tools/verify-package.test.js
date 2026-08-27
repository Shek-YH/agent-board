'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, 'verify-package.js'), 'utf8');

test('安装包校验不携带当前开发机绝对路径', () => {
  assert.doesNotMatch(source, /C:\\Users\\Administrator/i);
  assert.match(source, /forbiddenPathPattern/i);
});
