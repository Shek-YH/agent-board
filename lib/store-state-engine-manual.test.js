'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

test('Store exposes separate V2 mark-seen, mark-turn-done and close-session actions', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-state-manual-'));
  try {
    const script = [
      "const store = require('./lib/store');",
      "store.ingest({agent:'codex',sessionId:'manual',sourceId:'start',kind:'turn_start',turnId:'turn-1',ts:100});",
      "const done = store.markStateEngineTurnDone('codex:manual', 'turn-1');",
      "const seen = store.markStateEngineSeen('codex:manual');",
      "const closed = store.closeStateEngineSession('codex:manual');",
      "process.stdout.write(JSON.stringify({done:done.turnState,seen:seen.attentionState,closed:closed.sessionLifecycle,turn:closed.turnState}));",
    ].join('');
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, STATE_ENGINE_V2: 'on', AB_DATA_DIR: dataDir },
      encoding: 'utf8', windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { done: 'COMPLETED', seen: 'NONE', closed: 'CLOSED', turn: 'COMPLETED' });
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
