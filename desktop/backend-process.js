'use strict';

const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

function buildBackendLaunch({ nodeRuntime, backendEntry, port, dataDir, env = process.env }) {
  return {
    command: nodeRuntime,
    args: [backendEntry],
    options: {
      cwd: path.dirname(backendEntry),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...env, AB_PORT: String(port), AB_DATA_DIR: dataDir, AB_RUNTIME: 'desktop' },
    },
  };
}

function startBackend(launch, spawnImpl = spawn) {
  const child = spawnImpl(launch.command, launch.args, launch.options);
  return { child, launch };
}

function probeBackend(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const request = http.get({ host, port, path: '/api/state', timeout: 1000 }, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.once('timeout', () => { request.destroy(); resolve(false); });
    request.once('error', () => resolve(false));
  });
}

function waitForBackend(port, { host = '127.0.0.1', intervalMs = 250, timeoutMs = 20000, probe = probeBackend } = {}) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = async () => {
      if (await probe(port, host)) { resolve(true); return; }
      if (Date.now() >= deadline) { resolve(false); return; }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

function stopBackend(child, { timeoutMs = 2000 } = {}) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.killed) { resolve(); return; }
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      resolve();
    };
    child.once('exit', finish);
    try { child.kill('SIGTERM'); } catch { finish(); return; }
    setTimeout(() => {
      if (finished) return;
      try { child.kill('SIGKILL'); } catch { /* process may have exited */ }
      finish();
    }, timeoutMs);
  });
}

module.exports = { buildBackendLaunch, startBackend, probeBackend, waitForBackend, stopBackend };
