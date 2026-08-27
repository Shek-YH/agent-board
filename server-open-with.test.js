'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

test('open-with 只有在启动命令被系统接受后才返回成功', () => {
  const block = source.slice(source.indexOf("if (pathname === '/api/open-with'"));
  assert.match(block, /await execCommand\(full/);
  assert.doesNotMatch(block, /exec\(full,[\s\S]*?res\.writeHead\(200/);
});
