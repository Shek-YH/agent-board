'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { replay } = require('./replay');

const FIXTURES_DIR = path.join(__dirname, '..', '..', 'tests', 'fixtures', 'state-engine');

function readFixture(name) {
  const fixtureDir = path.join(FIXTURES_DIR, name);
  const input = fs.readFileSync(path.join(fixtureDir, 'input.ndjson'), 'utf8')
    .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const expected = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'expected.json'), 'utf8'));
  return { input, expected };
}

function canonical(runtime) {
  return {
    liveness: runtime.liveness,
    sessionLifecycle: runtime.sessionLifecycle,
    turnState: runtime.turnState,
    activityState: runtime.activityState,
    attentionState: runtime.attentionState,
    currentTurnId: runtime.currentTurnId,
    activeToolIds: runtime.activeToolIds,
    activeSubagentIds: runtime.activeSubagentIds,
  };
}

test('golden state-engine fixtures replay to their expected canonical states', () => {
  const names = fs.readdirSync(FIXTURES_DIR).filter((name) => fs.statSync(path.join(FIXTURES_DIR, name)).isDirectory()).sort();
  assert.ok(names.length >= 5, 'expected at least five state-engine fixtures');
  for (const name of names) {
    const { input, expected } = readFixture(name);
    assert.deepEqual(canonical(replay(input).runtime), expected.canonical, name);
  }
});
