'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(__dirname, 'preload.js'), 'utf8');
const renderer = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

test('Electron 桌面端为 WorkBuddy completion SSE 提供系统通知通道', () => {
  assert.match(main, /Notification/);
  assert.match(main, /notification:completion/);
  assert.match(preload, /notifyCompletion/);
  assert.match(renderer, /addEventListener\(['"]completion['"]|addEventListener\("completion"/);
  assert.match(renderer, /notifyCompletion/);
});
