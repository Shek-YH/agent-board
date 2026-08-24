'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const installRoot = 'C:/Users/Administrator/AppData/Local/Programs/DSH Desktop/resources/app.asar.unpacked/lib';
const runtimePath = `${installRoot}/electron-runtime-ygt697jw.js`;
const mainPath = `${installRoot}/main.js`;

test('DSH Desktop re-reveals the window when flushing a queued session request', () => {
  const main = fs.readFileSync(mainPath, 'utf8');
  assert.match(main, /if \(!runtime\.dispatchSessionOpen\(request\)\) return;\s+runtime\.show\(\);/);
});

test('DSH Desktop uses the Windows foreground activation path', () => {
  const runtime = fs.readFileSync(runtimePath, 'utf8');
  assert.match(runtime, /app\.focus\(\{ steal: true \}\)/);
  assert.match(runtime, /setAlwaysOnTop\(true/);
});
