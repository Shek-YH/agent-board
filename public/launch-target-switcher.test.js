'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

test('模型端口设置加载自动目标并提供两个互斥切换按钮', () => {
  assert.match(app, /\/api\/launch-targets/);
  assert.match(app, /manualDesktop/);
  assert.match(app, /切换到 CLI/);
  assert.match(app, /切换到桌面端/);
  assert.match(app, /保存并切换到桌面端/);
  assert.match(app, /data-target="cli"/);
  assert.match(app, /data-target="desktop"/);
  assert.match(app, /launchAgent\(id, button\.dataset\.target\)/);
  assert.match(app, /lo-manual-enabled/);
});

test('模型端口自动识别不会因空响应或非 JSON 响应遮蔽真实错误', () => {
  assert.match(app, /async function readJsonResponse/);
  assert.match(app, /response\.text\(\)/);
  assert.match(app, /readJsonResponse\(r\)/);
  assert.match(app, /服务端没有返回 JSON/);
  assert.match(app, /HTTP \$\{response\.status\}/);
});

test('模型端口设置包含窄屏可滚动卡片样式', () => {
  assert.match(html, /lo-agent-row/);
  assert.match(html, /lo-manual-block/);
  assert.match(app, /maxWidth = 'calc\(100vw - 24px\)'/);
});
