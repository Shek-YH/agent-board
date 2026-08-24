'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

test('session 卡片展示 Codex 多状态标签并接收 runtimeStatuses', () => {
  assert.match(source, /runtimeStatuses/);
  assert.match(source, /waiting_approval/);
  assert.match(source, /waiting_user_input/);
  assert.match(source, /interrupted/);
  assert.match(source, /failed/);
  assert.match(source, /stale_active/);
  assert.match(source, /状态待确认/);
});
