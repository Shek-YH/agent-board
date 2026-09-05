'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { buildPermissionSnapshot } = require('./permission-snapshot');

test('permission snapshot is project scoped, denies sensitive capabilities by default, and is immutable', () => {
  const snapshot = buildPermissionSnapshot({ projectPath: 'C:\\work\\app', now: 1700000000000 });
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.snapshotVersion, 1);
  assert.equal(snapshot.allowedRoot, 'C:\\work\\app');
  assert.deepEqual(snapshot.allowedReadRoots, ['C:\\work\\app']);
  assert.deepEqual(snapshot.allowedWriteRoots, ['C:\\work\\app']);
  assert.equal(snapshot.allowRead, true);
  assert.equal(snapshot.allowWrite, true);
  assert.equal(snapshot.allowTests, true);
  assert.deepEqual(snapshot.allowedGitOperations, ['status', 'diff', 'branch', 'log']);
  assert.equal(snapshot.allowExternalSideEffects, false);
  assert.equal(snapshot.maxLoopCount, 20);
  assert.equal(snapshot.maxRuntimeMs, 3_600_000);
  assert.equal(snapshot.allowSecrets, false);
  assert.equal(snapshot.allowNetwork, false);
  assert.equal(snapshot.researchRead, false);
  assert.deepEqual(snapshot.allowedResearchDomains, []);
  assert.equal(snapshot.allowInstall, false);
  assert.equal(snapshot.allowGitPush, false);
  assert.equal(snapshot.capturedAt, 1700000000000);
  assert.match(snapshot.snapshotHash, /^[a-f0-9]{64}$/);
  assert.match(snapshot.snapshotId, /^ps-/);
  assert.throws(() => { snapshot.allowNetwork = true; }, TypeError);
});

test('permission snapshot reflects explicit safety settings without exposing unknown fields', () => {
  const snapshot = buildPermissionSnapshot({
    projectPath: 'C:\\work\\app',
    settings: { safety: { allowNetwork: true, allowInstall: true, allowSecrets: true, allowGitPush: true } },
    now: 1700000000000,
  });
  assert.equal(snapshot.allowNetwork, true);
  assert.equal(snapshot.allowInstall, true);
  assert.equal(snapshot.allowSecrets, true);
  assert.equal(snapshot.allowGitPush, true);
  assert.deepEqual(snapshot.allowedNetworkDomains, []);
  assert.equal('apiKey' in snapshot, false);
});

test('permission snapshot captures immutable research read permission and its domain allowlist', () => {
  const snapshot = buildPermissionSnapshot({
    projectPath: 'C:\\work\\app',
    settings: { safety: { researchRead: true, allowedResearchDomains: ['docs.example.com', 'docs.example.com'] } },
    now: 1700000000000,
  });
  assert.equal(snapshot.researchRead, true);
  assert.deepEqual(snapshot.allowedResearchDomains, ['docs.example.com']);
  assert.throws(() => { snapshot.allowedResearchDomains.push('evil.example'); }, TypeError);
});
