'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

test('Store forwards WorkBuddy hook, heartbeat and SessionEnd evidence to V2', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-state-engine-workbuddy-'));
  try {
    const script = [
      "const store = require('./lib/store');",
      "const base = { provider: 'workbuddy', sessionId: 'workbuddy-session', turnId: 'turn-1', activeToolIds: [], activeSubagentIds: [], lastStopHookActive: false };",
      "store.noteWorkBuddyRuntimeStatus('workbuddy:workbuddy-session', { ...base, lastEventType: 'UserPromptSubmit', lastEventAt: 100 });",
      "store.noteWorkBuddyRuntimeStatus('workbuddy:workbuddy-session', { ...base, lastEventType: 'Stop', lastEventAt: 200 });",
      "store.noteHeartbeat('workbuddy:workbuddy-session', true, 210);",
      "store.noteWorkBuddyRuntimeStatus('workbuddy:workbuddy-session', { ...base, lastEventType: 'SessionEnd', lastEventAt: 300 });",
      "const s = store.getRuntimeStatuses(300)['workbuddy:workbuddy-session'];",
      "process.stdout.write(JSON.stringify({ mode: s.state_engine_mode, canonical: s.canonical_state, ui: s.ui_status.key, turnId: s.currentTurnId }));",
    ].join('');
    const result = spawnSync(process.execPath, ['-e', script], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, STATE_ENGINE_V2: 'on', AB_DATA_DIR: dataDir },
      encoding: 'utf8',
      windowsHide: true,
    });

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.mode, 'on');
    assert.equal(output.canonical.liveness, 'ALIVE');
    assert.equal(output.canonical.sessionLifecycle, 'CLOSED');
    assert.equal(output.canonical.turnState, 'COMPLETION_CANDIDATE');
    assert.equal(output.ui, 'completion_candidate');
    assert.equal(output.turnId, 'turn-1');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
