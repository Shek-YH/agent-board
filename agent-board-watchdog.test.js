'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { writeRuntimeMarker } = require('./lib/runtime-marker');
const { isServerAvailable } = require('./agent-board-watchdog');

test('watchdog 优先探测 Electron marker 中的实际端口和运行身份', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-watchdog-'));
  const marker = {
    pid: 4321,
    port: 49876,
    serverEntry: path.join(dataDir, 'server.js'),
    serverEntrySha256: 'hash',
  };
  writeRuntimeMarker(marker, { dataDir });
  const calls = [];
  const available = await isServerAvailable({
    dataDir,
    pingImpl: async (port, expected) => {
      calls.push({ port, expected });
      return port === marker.port && expected?.serverEntrySha256 === marker.serverEntrySha256;
    },
  });
  assert.equal(available, true);
  assert.deepEqual(calls.map((call) => call.port), [marker.port]);
});
