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

test('health exposes only a bounded diagnostics summary', () => {
  assert.match(source, /createDiagnostics/);
  assert.match(source, /const runtimeDiagnostics = createDiagnostics\(\)/);
  assert.match(source, /diagnostics: runtimeDiagnostics\.summary\(\)/);
  assert.doesNotMatch(source, /diagnostics: runtimeDiagnostics\.snapshot\(\)/);
});

test('state engine diagnostics exposes read-only status and redacted bundle routes', () => {
  assert.match(source, /getStateEngineDiagnostics/);
  assert.match(source, /\/api\/state-engine\/diagnostics/);
  assert.match(source, /bundle/);
});

test('state engine exposes separate manual seen/turn-done/session-close mutation routes', () => {
  assert.match(source, /markStateEngineSeen/);
  assert.match(source, /markStateEngineTurnDone/);
  assert.match(source, /closeStateEngineSession/);
  assert.match(source, /state-engine\/mark-seen/);
  assert.match(source, /state-engine\/mark-turn-done/);
  assert.match(source, /state-engine\/close-session/);
});
