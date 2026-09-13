'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, 'electron-smoke.js'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

test('desktop smoke uses isolated user data and verifies the real backend health flow', () => {
  assert.equal(packageJson.scripts['desktop:smoke'], 'node tools/electron-smoke.js');
  assert.match(source, /mkdtempSync/);
  assert.match(source, /--user-data-dir/);
  assert.match(source, /packagedBinary/);
  assert.match(source, /\/api\/ready/);
  assert.match(source, /\/api\/state/);
  assert.match(source, /getJson\(ready\.port, '\/api\/state\?range=day', 15000\)/);
  assert.match(source, /\/api\/health/);
  assert.match(source, /runtimeMode.*desktop/);
  assert.match(source, /taskkill\.exe/);
});
