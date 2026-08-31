'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { AutoPilotSettingsStore, DEFAULT_SETTINGS } = require('./settings-store');

function makePath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-settings-'));
  return path.join(dir, 'settings.json');
}

test('settings store returns safe defaults and does not expose mutable internal state', () => {
  const store = new AutoPilotSettingsStore(makePath());
  const settings = store.get();

  assert.equal(settings.autopilot.defaultMode, 'auto');
  assert.equal(settings.routing.preset, 'balanced');
  assert.equal(settings.safety.permissionApproval, 'human-only');
  settings.autopilot.defaultMode = 'suggest';
  assert.equal(store.get().autopilot.defaultMode, DEFAULT_SETTINGS.autopilot.defaultMode);
});

test('settings store persists known values and drops unknown fields after reload', () => {
  const filePath = makePath();
  const store = new AutoPilotSettingsStore(filePath);
  const updated = store.update({
    autopilot: { defaultMode: 'suggest', maxIterations: 7 },
    routing: { enabled: false, preset: 'quality' },
    unknown: { apiKey: 'must-not-persist' },
  });

  assert.equal(updated.autopilot.defaultMode, 'suggest');
  assert.equal(updated.autopilot.maxIterations, 7);
  assert.equal(updated.routing.enabled, false);
  assert.equal('unknown' in updated, false);
  assert.doesNotMatch(fs.readFileSync(filePath, 'utf8'), /must-not-persist/);

  const reloaded = new AutoPilotSettingsStore(filePath);
  assert.equal(reloaded.get().autopilot.defaultMode, 'suggest');
  assert.equal(reloaded.get().autopilot.maxIterations, 7);
  assert.equal(reloaded.get().routing.preset, 'quality');
});

test('settings store reset restores defaults and removes temporary file', () => {
  const filePath = makePath();
  const store = new AutoPilotSettingsStore(filePath);
  store.update({ autopilot: { maxRuntimeMs: 99_000 } });
  assert.equal(store.reset().autopilot.maxRuntimeMs, DEFAULT_SETTINGS.autopilot.maxRuntimeMs);
  assert.equal(fs.existsSync(filePath + '.tmp'), false);
});

