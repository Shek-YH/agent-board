'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { buildRuntimeIdentity } = require('./runtime-identity');

test('buildRuntimeIdentity captures startup provenance and entry hash', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-runtime-'));
  const entry = path.join(root, 'server.js');
  try {
    fs.writeFileSync(entry, 'old server source', 'utf8');
    const identity = buildRuntimeIdentity({
      serverRoot: root,
      serverEntry: entry,
      cwd: root,
      nodeRuntime: path.join(root, 'runtime', 'node.exe'),
      nodeVersion: 'v22.22.2',
      pid: 1234,
      ppid: 5678,
      port: 4876,
      startedAt: '2026-08-26T03:25:06.000Z',
      runtimeMode: 'source',
      dataDir: path.join(root, 'data'),
      configDir: path.join(root, 'config'),
    });
    fs.writeFileSync(entry, 'new server source', 'utf8');

    assert.equal(identity.schemaVersion, 1);
    assert.equal(identity.serverRoot, path.resolve(root));
    assert.equal(identity.serverEntry, path.resolve(entry));
    assert.equal(identity.cwd, path.resolve(root));
    assert.equal(identity.nodeRuntime, path.resolve(root, 'runtime', 'node.exe'));
    assert.equal(identity.nodeVersion, 'v22.22.2');
    assert.equal(identity.pid, 1234);
    assert.equal(identity.ppid, 5678);
    assert.equal(identity.port, 4876);
    assert.equal(identity.startedAt, '2026-08-26T03:25:06.000Z');
    assert.equal(identity.runtimeMode, 'source');
    assert.equal(identity.dataDir, path.resolve(root, 'data'));
    assert.equal(identity.configDir, path.resolve(root, 'config'));
    assert.equal(
      identity.serverEntrySha256,
      crypto.createHash('sha256').update('old server source').digest('hex'),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('buildRuntimeIdentity omits unavailable optional paths instead of inventing them', () => {
  const identity = buildRuntimeIdentity({
    serverRoot: 'C:\\AgentBoard',
    serverEntry: 'C:\\AgentBoard\\server.js',
    nodeRuntime: 'C:\\AgentBoard\\runtime\\node.exe',
    port: 4876,
  });

  assert.equal(identity.dataDir, null);
  assert.equal(identity.configDir, null);
  assert.equal(identity.port, 4876);
});
