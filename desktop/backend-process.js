'use strict';

const http = require('node:http');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');

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

function probeBackend(port, host = '127.0.0.1', expectedRuntime = null) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const request = http.get({ host, port, path: '/api/ready', timeout: 3000 }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        if (response.statusCode !== 200) { finish(false); return; }
        if (!expectedRuntime) { finish(true); return; }
        try {
          const runtime = JSON.parse(Buffer.concat(chunks).toString('utf8')).runtime || {};
          finish(['serverEntry', 'serverRoot', 'port', 'runtimeMode'].every((key) => (
            expectedRuntime[key] === undefined || runtime[key] === expectedRuntime[key]
          )));
        } catch { finish(false); }
      });
    });
    request.once('timeout', () => { request.destroy(); finish(false); });
    request.once('error', () => finish(false));
  });
}

function waitForBackend(port, {
  host = '127.0.0.1', intervalMs = 250, timeoutMs = 20000, probe = probeBackend, child = null, expectedRuntime = null,
} = {}) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    let timer = null;
    let settled = false;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (child?.removeListener) {
        child.removeListener('exit', onExit);
        child.removeListener('error', onExit);
      }
    };
    const finish = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const onExit = () => finish(false);
    if (child?.exitCode !== null && child?.exitCode !== undefined) {
      finish(false);
      return;
    }
    child?.once?.('exit', onExit);
    child?.once?.('error', onExit);
    const tick = async () => {
      if (settled) return;
      let ready = false;
      try { ready = await probe(port, host, expectedRuntime); } catch { /* keep polling */ }
      if (ready) { finish(true); return; }
      if (settled || Date.now() >= deadline) { finish(false); return; }
      timer = setTimeout(tick, intervalMs);
    };
    tick();
  });
}

function killProcessTreeByPid(pid, execFileImpl = execFile) {
  return new Promise((resolve, reject) => {
    execFileImpl('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function stopBackend(child, {
  timeoutMs = 2000,
  platform = process.platform,
  killProcessTree = killProcessTreeByPid,
} = {}) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null && child.exitCode !== undefined) { resolve(); return; }
    let finished = false;
    let forceTimer = null;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (forceTimer) clearTimeout(forceTimer);
      resolve();
    };
    child.once('exit', finish);
    const killDirectly = () => {
      if (finished) return;
      try { child.kill('SIGTERM'); } catch { finish(); return; }
      if (finished) return;
      forceTimer = setTimeout(() => {
        if (finished) return;
        try { child.kill('SIGKILL'); } catch { /* process may have exited */ }
        finish();
      }, timeoutMs);
    };
    if (platform === 'win32' && child.pid) {
      Promise.resolve()
        .then(() => killProcessTree(child.pid))
        .then(finish)
        .catch(killDirectly);
      return;
    }
    killDirectly();
  });
}

module.exports = { buildBackendLaunch, startBackend, probeBackend, waitForBackend, stopBackend };
