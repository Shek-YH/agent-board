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
