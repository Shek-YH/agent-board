'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname);
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

test('Session card uses a direct AI takeover label instead of a setup label', () => {
  assert.match(app, /kind: 'setup', label: 'AI 托管'/);
  assert.match(app, /🤖 \$\{esc\(autopilotSummary\.label\)\}/);
});

test('Session fast path submits only the current session reference and Goal', () => {
  assert.match(app, /\/api\/orchestration\/workflows\/from-session/);
  assert.match(app, /sessionRef: s\.id/);
  assert.match(app, /goalSource/);
  assert.match(app, /AI 托管当前 Session/);
  assert.match(app, /从当前项目 PRD 生成/);
  assert.match(app, /开始 AI 托管/);
  assert.match(app, /autopilot-prd-preview/);
  assert.match(app, /data\.draft\.dod/);
});

test('Session fast path keeps the current Agent and project as locked context', () => {
  assert.match(app, /const sessionAgent = agentMeta\(s\.agent\)/);
  assert.match(app, /const sessionProject = s\.project/);
  assert.match(app, /客户端不能修改 Agent、Session 或项目绑定/);
  assert.match(html, /id="ai-create-form"/);
  assert.match(app, /高级设置|手动创建/);
});

test('AI intelligent execution scheduling is edited as a global persisted setting', () => {
  assert.match(app, /\/api\/orchestration\/settings/);
  assert.match(app, /保存全局设置/);
  assert.match(app, /默认模式/);
  assert.match(app, /最大循环轮数/);
  assert.match(app, /跨 Workflow 生效/);
  assert.doesNotMatch(app, /应用到 Workflow/);
});

test('Provider Key is configured once for all Agents and shared voice capabilities', () => {
  assert.match(app, /所有 Agent 共用|Agent 共用/);
  assert.match(app, /语音 ASR|语音识别/);
  assert.match(app, /TTS|语音合成/);
  assert.match(app, /dashscope|zai|ark|minimax|deepgram|elevenlabs/);
});
