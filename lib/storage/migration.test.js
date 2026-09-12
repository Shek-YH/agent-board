'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { inspectSnapshotFile, dryRunMigration, rollbackFiles } = require('./migration');

function writeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-migration-'));
  const dataPath = path.join(root, 'data.json');
  const userPath = path.join(root, 'user-data.json');
  fs.writeFileSync(dataPath, JSON.stringify({
    sessions: [{ id: 's1' }], messages: [{ id: 'm1' }], hidden: [{ id: 'h1' }], manual_status: [{ id: 's1' }],
  }), 'utf8');
  fs.writeFileSync(userPath, JSON.stringify({ todoTasks: [{ id: 't1' }], prompts: [{ id: 'p1' }] }), 'utf8');
  return { root, dataPath, userPath };
}

test('migration dry run records hashes, sizes, and counts without writing', () => {
  const fixture = writeFixture();
  const before = inspectSnapshotFile(fixture.dataPath);
  const result = dryRunMigration({
    dataPath: fixture.dataPath,
    userDataPath: fixture.userPath,
    target: { sessions: [{ id: 's1' }], messages: [{ id: 'm1' }], hidden: [{ id: 'h1' }], manual_status: [{ id: 's1' }], todoTasks: [{ id: 't1' }], prompts: [{ id: 'p1' }] },
  });
  assert.equal(result.ok, true);
  assert.equal(result.wouldWrite, false);
  assert.equal(result.before.data.sha256.length, 64);
  assert.deepEqual(result.before.data.counts, before.counts);
  assert.equal(fs.readFileSync(fixture.dataPath, 'utf8'), JSON.stringify({ sessions: [{ id: 's1' }], messages: [{ id: 'm1' }], hidden: [{ id: 'h1' }], manual_status: [{ id: 's1' }] }));
  fs.rmSync(fixture.root, { recursive: true, force: true });
});

test('migration dry run aborts on count mismatch and rollback restores backups', () => {
  const fixture = writeFixture();
  const backupDir = path.join(fixture.root, 'backup');
  fs.mkdirSync(backupDir);
  fs.copyFileSync(fixture.dataPath, path.join(backupDir, 'data.json'));
  fs.copyFileSync(fixture.userPath, path.join(backupDir, 'user-data.json'));
  const result = dryRunMigration({
    dataPath: fixture.dataPath,
    userDataPath: fixture.userPath,
    target: { sessions: [], messages: [], hidden: [], manual_status: [], todoTasks: [], prompts: [] },
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /count mismatch/);
  fs.writeFileSync(fixture.dataPath, 'changed', 'utf8');
  rollbackFiles({ backupDir, dataPath: fixture.dataPath, userDataPath: fixture.userPath });
  assert.deepEqual(JSON.parse(fs.readFileSync(fixture.dataPath, 'utf8')).sessions, [{ id: 's1' }]);
  fs.rmSync(fixture.root, { recursive: true, force: true });
});
