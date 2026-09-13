'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

test('SSE client tracks sequence gaps and reloads authoritative snapshots', () => {
  assert.match(source, /lastSeq/);
  assert.match(source, /sequence gap|SSE.*gap/i);
  assert.match(source, /loadState\(\)/);
  assert.match(source, /loadBoard\(\)/);
});

test('SSE client unwraps versioned envelopes while retaining legacy payload support', () => {
  assert.match(source, /parsed\.version\s*===\s*1/);
  assert.match(source, /payload/);
  assert.match(source, /JSON\.parse\(raw\)/);
});
