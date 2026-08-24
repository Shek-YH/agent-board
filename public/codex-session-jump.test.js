'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('Codex session 卡片跳转使用对应 threadId，而不是只激活 Codex 应用', () => {
  assert.match(app, /function openCodexThread\(sessionId\)/);
  assert.match(app, /function extractCodexThreadId\(sessionId\)/);
  assert.match(app, /function jumpToAgentSession\(s\)[\s\S]*?s\.agent === 'codex'[\s\S]*?openCodexThread\(s\.session_id\)/);
  assert.match(app, /jumpToAgentSession\(s\)/);
});

test('Codex 详情抽屉跳转使用对应 threadId', () => {
  assert.match(app, /body\.querySelector\('\.d-jump'\)\.onclick = \(\) => jumpToAgentSession\(s\)/);
});

test('后端只接受 threadId 并通过固定 Codex 深链打开，不接受任意 URL', () => {
  assert.match(server, /\/api\/open-codex-thread/);
  assert.match(server, /buildCodexDeepLink\(threadId\)/);
  assert.doesNotMatch(server, /body\.url/);
});

test('session 卡片带有可复制的 session ID 和稳定 data-session-id 属性', () => {
  assert.match(app, /card\.dataset\.sessionId/);
  assert.match(app, /class="s-sid"/);
  assert.match(app, /data-session-id=/);
  assert.match(app, /querySelector\('\.s-sid'\)/);
});
