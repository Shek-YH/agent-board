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

test('完成弹窗受理回执（ack）契约：主进程返回 tsAck/popupShown，渲染层以弹窗受理时刻为权威完成时刻', () => {
  // 主进程：受理即记录 tsAck 并返回结构化回执（弹不弹都回执，与系统通知解耦）
  assert.match(main, /function showAgentCompletionNotification/);
  assert.match(main, /const tsAck = Date\.now\(\)/);
  assert.match(main, /COMPLETION_AGENT_LABELS/);
  assert.match(main, /popupShown/);
  assert.match(main, /return \{ ok: true, tsAck, popupShown: true/);
  assert.match(main, /NOTIFICATION_UNSUPPORTED/);
  // 渲染层：completion SSE → 先收 ack 取 tsAck 作为权威完成时间，再本地立即点亮卡片
  assert.match(renderer, /notifyCompletion\?\.\(provider, sessionId\)/);
  assert.match(renderer, /completedAt = ack && ack\.ok && Number\(ack\.tsAck\)/);
  assert.match(renderer, /markCompletionOnce/);
  assert.match(renderer, /completionMarkedAt/);
  assert.match(renderer, /syncCompletedCardState/);
});
