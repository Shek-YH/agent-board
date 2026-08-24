'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

test('较长 session ID 的可见标签会统一截断，避免挤压状态标签造成卡片变高', () => {
  assert.match(app, /function displaySessionId\(sessionId\)\s*\{/);
  assert.match(app, /const sessionIdLabel = displaySessionId\(sessionId\)/);
  assert.match(app, /value\.length > 16/);
  assert.match(app, /value\.slice\(0, 8\).*value\.slice\(-5\)/s);
  assert.match(app, /esc\(sessionIdLabel\)/);
});
