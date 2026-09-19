'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

test('desktop server authenticates sensitive UI mutations before Jarvis and orchestration handlers', () => {
  assert.match(source, /createRuntimeAuth/);
  assert.match(source, /pathname === '\/api\/runtime-auth'/);
  assert.match(source, /authorizeUiMutation/);
  assert.match(source, /DEFAULT_HOOK_PATH/);
  const authBoundary = source.indexOf('Unauthorized Agent Board UI request');
  const jarvisHandler = source.indexOf("pathname === '/api/jarvis/voice'");
  const orchestrationHandler = source.indexOf("pathname.startsWith('/api/orchestration/')");
  assert.ok(authBoundary > 0 && authBoundary < jarvisHandler, 'Jarvis voice must be behind Runtime Auth');
  assert.ok(authBoundary < orchestrationHandler, 'orchestration routes must be behind Runtime Auth');
  assert.match(source, /pathname !== '\/api\/complete'\s*&&\s*pathname !== DEFAULT_HOOK_PATH/);
});

test('completion hook has a separate authenticated JSON boundary', () => {
  assert.match(source, /AGENT_BOARD_COMPLETE_HOOK_TOKEN/);
  assert.match(source, /COMPLETE_HOOK_AUTH/);
  assert.match(source, /Unauthorized Agent completion hook/);
  assert.match(source, /readJsonBody\(req\)/);
});
