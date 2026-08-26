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
  assert.match(app, /data-action="takeover"/);
  assert.doesNotMatch(app, /ai-workflow-action[^\n]*open-with/);
});
