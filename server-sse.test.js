'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

test('server broadcasts one versioned sequence envelope to every SSE client', () => {
  assert.match(source, /require\('\.\/lib\/sse-protocol'\)/);
  assert.match(source, /const sseSequence = new SseSequence\(\)/);
  assert.match(source, /formatSseEvent\(sseSequence\.next\(event, data\)\)/);
  assert.match(source, /sseClients\.add\(res\)/);
  assert.match(source, /writeSseEvent\(res, 'hello'/);
  assert.match(source, /writeSseEvent\(res, 'active'/);
});
