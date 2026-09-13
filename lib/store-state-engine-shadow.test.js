'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

test('Store sends Codex lifecycle events to the V2 shadow bridge without changing legacy state', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-state-engine-shadow-'));
  try {
    const script = [
      "const store = require('./lib/store');",
      "store.ingest({ agent: 'codex', sessionId: 'shadow-session', sourceId: 'start', kind: 'turn_start', turnId: 'turn-1', ts: 100 });",
      "store.ingest({ agent: 'codex', sessionId: 'shadow-session', sourceId: 'complete', kind: 'turn_end', turnId: 'turn-1', turnStatus: 'completed', completionHoldMs: 5000, ts: 200 });",
      "const s = store.getStateEngineStatuses()['codex:shadow-session'];",
      "process.stdout.write(JSON.stringify({ mode: s.mode, source: s.source, canonical: s.canonical_state, legacy: s.legacy_state }));",
    ].join('');
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, STATE_ENGINE_V2: 'shadow', AB_DATA_DIR: dataDir },
      encoding: 'utf8',
      windowsHide: true,
    });

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.mode, 'shadow');
    assert.equal(output.source, 'legacy');
    assert.equal(output.canonical.sessionLifecycle, 'OPEN');
    assert.equal(output.canonical.turnState, 'COMPLETION_CANDIDATE');
    assert.equal(output.legacy, 'running');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
