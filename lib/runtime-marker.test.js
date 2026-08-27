'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  getRuntimeMarkerPath,
  writeRuntimeMarker,
  readRuntimeMarker,
  matchesRuntimeIdentity,
  clearRuntimeMarker,
} = require('./runtime-marker');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-runtime-'));
}

test('runtime marker 可写入、读取，并校验 PID/端口/源码身份', () => {
  const dataDir = tempDir();
  const identity = {
    pid: 1234,
    port: 49876,
    serverEntry: path.join(dataDir, 'server.js'),
    serverEntrySha256: 'source-hash',
    runtimeMode: 'desktop',
  };
  assert.equal(writeRuntimeMarker(identity, { dataDir }), true);
  const markerPath = getRuntimeMarkerPath(dataDir);
  assert.equal(readRuntimeMarker({ dataDir }).pid, 1234);
  assert.equal(matchesRuntimeIdentity(readRuntimeMarker({ markerPath }), identity), true);
  assert.equal(matchesRuntimeIdentity(readRuntimeMarker({ markerPath }), { ...identity, port: 4876 }), false);
});

test('清理 marker 时不会误删另一个运行实例的 marker', () => {
  const dataDir = tempDir();
  const first = { pid: 1, port: 1, serverEntry: 'a', serverEntrySha256: 'a' };
  const second = { pid: 2, port: 2, serverEntry: 'b', serverEntrySha256: 'b' };
  writeRuntimeMarker(second, { dataDir });
  assert.equal(clearRuntimeMarker(first, { dataDir }), false);
  assert.equal(fs.existsSync(getRuntimeMarkerPath(dataDir)), true);
  assert.equal(clearRuntimeMarker(second, { dataDir }), true);
  assert.equal(fs.existsSync(getRuntimeMarkerPath(dataDir)), false);
});
