'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

test('desktop server exposes a separate UI runtime auth boundary for mutations', () => {
  assert.match(source, /createRuntimeAuth/);
  assert.match(source, /pathname === '\/api\/runtime-auth'/);
  assert.match(source, /authorizeUiMutation/);
  assert.match(source, /DEFAULT_HOOK_PATH/);
  assert.match(source, /pathname !== '\/api\/complete'/);
});
