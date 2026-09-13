'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createDiagnostics, sanitizeDiagnostic } = require('./diagnostics');

test('diagnostics keep only bounded structured fields for each runtime category', () => {
  const diagnostics = createDiagnostics({ now: () => 1234 });
  for (const kind of ['transition', 'scan', 'storage', 'sse']) {
    diagnostics.record({ kind, component: 'store', action: 'updated', status: 'ok', count: 2, seq: 4 });
  }

  assert.deepEqual(diagnostics.snapshot(), [
    { id: '1', at: 1234, kind: 'transition', component: 'store', action: 'updated', status: 'ok', count: 2, seq: 4 },
    { id: '2', at: 1234, kind: 'scan', component: 'store', action: 'updated', status: 'ok', count: 2, seq: 4 },
    { id: '3', at: 1234, kind: 'storage', component: 'store', action: 'updated', status: 'ok', count: 2, seq: 4 },
    { id: '4', at: 1234, kind: 'sse', component: 'store', action: 'updated', status: 'ok', count: 2, seq: 4 },
  ]);
});

test('diagnostics drop prompts, replies, paths, secrets, and unknown fields', () => {
  const safe = sanitizeDiagnostic({
    kind: 'storage', action: 'save', status: 'error', code: 'STORAGE_FAILED',
    prompt: 'do not persist', reply: 'do not persist', filePath: 'C:\\Users\\secret\\data.json',
    token: 'do-not-persist', unknown: 'drop me',
  });

  assert.deepEqual(safe, { kind: 'storage', action: 'save', status: 'error', code: 'STORAGE_FAILED' });
  assert.equal(JSON.stringify(safe).includes('do-not-persist'), false);
  assert.equal(JSON.stringify(safe).includes('Users'), false);
});

test('diagnostics use a bounded ring and expose counts without raw entries', () => {
  const diagnostics = createDiagnostics({ maxEntries: 2, now: () => 1 });
  diagnostics.record({ kind: 'sse', action: 'broadcast', status: 'ok', seq: 1 });
  diagnostics.record({ kind: 'sse', action: 'broadcast', status: 'ok', seq: 2 });
  diagnostics.record({ kind: 'sse', action: 'broadcast', status: 'ok', seq: 3 });

  assert.deepEqual(diagnostics.snapshot().map((item) => item.seq), [2, 3]);
  assert.deepEqual(diagnostics.summary(), { retained: 2, total: 3, lastKind: 'sse', lastStatus: 'ok' });
});
