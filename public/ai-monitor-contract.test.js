'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname);
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

test('manual and AI monitoring panels have separate navigation targets', () => {
  assert.match(html, /data-monitor-mode="manual"/);
  assert.match(html, /data-monitor-mode="ai"/);
  assert.match(html, /id="manual-monitor-panel"/);
  assert.match(html, /id="ai-monitor-panel"/);
  assert.match(app, /manual-monitor-panel/);
  assert.match(app, /ai-monitor-panel/);
});

test('AI monitor uses orchestration API and does not use desktop open endpoints', () => {
  assert.match(app, /\/api\/orchestration\/state/);
  assert.match(app, /\/api\/orchestration\/workflows/);
  assert.match(app, /data-action="suggest"/);
  assert.match(app, /data-action="takeover"/);
  assert.match(app, /autopilotMode/);
  assert.match(app, /data-action="auto-run"/);
  assert.match(app, /data-action="resume"/);
  assert.match(app, /data-action="stop"/);
  assert.doesNotMatch(app, /data-action="run"/);
  assert.doesNotMatch(app, /ai-workflow-action[^\n]*open-with/);
});

test('AI monitor captures the Suggest Mode run contract', () => {
  assert.match(html, /id="ai-in-scope"/);
  assert.match(html, /id="ai-out-of-scope"/);
  assert.match(html, /id="ai-dod"/);
  assert.match(html, /id="ai-evidence"/);
  assert.match(html, /id="ai-autopilot-mode"/);
  assert.match(html, /id="ai-session-ref"/);
  assert.match(html, /Suggest(?: Mode)?/);
});

test('AI monitor exposes the Jarvis recording MVP without coupling it to desktop navigation', () => {
  assert.match(html, /id="jarvis-record"/);
  assert.match(html, /id="jarvis-project-path"/);
  assert.match(html, /id="jarvis-audio"/);
  assert.match(app, /getUserMedia/);
  assert.match(app, /\/api\/jarvis\/voice/);
});

test('AI monitor exposes Model Routing settings and renders safe route summaries', () => {
  assert.match(html, /id="ai-routing-enabled"/);
  assert.match(html, /id="ai-routing-preset"/);
  assert.match(html, /id="ai-routing-model"/);
  assert.match(html, /id="ai-routing-reasoning"/);
  assert.match(app, /AI 智能执行调度/);
  assert.match(app, /\/api\/orchestration\/routing\/catalog/);
  assert.match(app, /\/routing/);
  assert.match(app, /lastRouting/);
  assert.match(app, /manualPin/);
  assert.doesNotMatch(app, /JSON\.stringify\([^)]*prompt/);
});

test('AI monitor exposes routing capability controls and safe catalog actions', () => {
  assert.match(html, /id="ai-routing-auto-model"/);
  assert.match(html, /id="ai-routing-auto-reasoning"/);
  assert.match(html, /id="ai-routing-respect-pin"/);
  assert.match(html, /id="ai-routing-allow-legacy"/);
  assert.match(app, /routing\/catalog\/refresh/);
  assert.match(app, /\/api\/orchestration\/settings/);
  assert.doesNotMatch(app, /应用到 Workflow/);
  assert.match(app, /Model Discovery|模型发现/);
});

test('AI monitor shows high-level Agent capability boundaries', () => {
  assert.match(html, /id="ai-agent-capability-list"/);
  assert.match(app, /\/api\/capabilities/);
  assert.match(app, /Session Auto/);
  assert.match(app, /Conversation Read/);
  assert.match(app, /Verified Send/);
  assert.match(app, /completionDetector/);
});

test('AI monitor exposes provider readiness without rendering credentials', () => {
  assert.match(html, /id="ai-provider-config"/);
  assert.match(app, /providerConfig/);
  assert.match(app, /Provider 配置状态/);
  assert.match(app, /safeStorage/);
  assert.match(app, /setApiKey/);
  assert.match(app, /clearApiKey/);
  assert.doesNotMatch(app, /secureProvider\.apiKey/);
  assert.doesNotMatch(app, /providerConfig[^\n]*(apiKey|token|secret)/i);
});

test('AI monitor exposes commercial routing diagnostics, explainability, usage, and receipt views', () => {
  assert.match(app, /routing-details/);
  assert.match(app, /routing\/overview/);
  assert.match(app, /Audit Timeline|路由时间线/);
  assert.match(app, /Catalog Diagnostics|Catalog 诊断/);
  assert.match(app, /Cost|成本/);
  assert.match(app, /Quota|配额/);
  assert.match(app, /Receipt|回执/);
  assert.doesNotMatch(app, /JSON\.stringify\([^)]*(instruction|token)/);
});

test('AI monitor exposes read-only historical routing insights and workspace safety', () => {
  assert.match(app, /routing\/insights/);
  assert.match(app, /\/api\/orchestration\/routing\/insights/);
  assert.match(app, /settings-routing-flywheel/);
  assert.match(app, /Routing Data Flywheel|历史路由数据/);
  assert.match(app, /taskClasses/);
  assert.match(app, /taskProfiles/);
  assert.match(app, /recommendations/);
  assert.match(app, /INSUFFICIENT_HISTORY|样本不足/);
  assert.match(app, /averageDurationMs|平均耗时/);
  assert.match(app, /历史成功率|Historical success/);
  assert.match(app, /Worktree|工作区/);
  assert.match(app, /仅建议|read-only/);
});
