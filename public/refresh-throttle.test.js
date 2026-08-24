'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

test('SSE 消息用合并后的状态刷新，避免每条消息立即发起请求', () => {
  assert.match(source, /const refreshState = \(\) => \{/);
  assert.match(source, /es\.addEventListener\('message', \(\) => \{ refreshState\(\); refreshBoard\(\); \}\);/);
  assert.doesNotMatch(source, /es\.addEventListener\('message', \(\) => \{ loadState\(\); refreshBoard\(\); \}\);/);
});

test('SSE 刷新间隔放慢到 5 秒，给卡片交互留出时间', () => {
  assert.match(source, /const SSE_REFRESH_INTERVAL_MS = 5000;/);
  assert.match(source, /stateTimer = setTimeout\(\(\) => \{ stateTimer = null; loadState\(\); \}, SSE_REFRESH_INTERVAL_MS\);/);
  assert.match(source, /boardTimer = setTimeout\(\(\) => \{ boardTimer = null; loadBoard\(\); \}, SSE_REFRESH_INTERVAL_MS\);/);
});
