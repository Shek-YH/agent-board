'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

test('提示音列表提供删除按钮，并在确认后调用删除接口', () => {
  assert.match(app, /class="btn sound-delete"/);
  assert.match(app, /确定要删除提示音/);
  assert.match(app, /fetch\('\/api\/sounds\/'\s*\+\s*encodeURIComponent\(soundId\)/);
  assert.match(app, /method:\s*'DELETE'/);
  assert.match(app, /if \(!confirm\(/);
});

test('删除接口空响应不会被误报为 JSON 解析错误', () => {
  assert.match(app, /async function readApiResponse\(response\)/);
  assert.match(app, /const body = await response\.text\(\)/);
  assert.match(app, /if \(!body\.trim\(\)\)/);
  assert.match(app, /throw new Error\('HTTP ' \+ response\.status\)/);
  assert.match(app, /const next = await readApiResponse\(response\)/);
});
