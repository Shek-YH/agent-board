'use strict';

const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const electronBinary = process.env.ELECTRON_BIN || require('electron');
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getJson(port, pathname) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path: pathname, timeout: 1500 }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve({ status: response.statusCode, body });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.once('timeout', () => request.destroy(new Error('request timeout')));
    request.once('error', reject);
  });
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function findDesktopBackend(preferredPort) {
  const portCandidates = [preferredPort];
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    for (const port of portCandidates) {
      try {
        const response = await getJson(port, '/api/ready');
        const runtime = response.body?.runtime || {};
        if (response.status === 200 && response.body?.ok === true && runtime.runtimeMode === 'desktop') {
          return { port, runtime };
        }
      } catch {
        // The Electron backend may not have opened its port yet.
      }
    }
    await sleep(250);
  }
  throw new Error('Electron backend did not become ready within 30 seconds');
}

async function stopProcessTree(child) {
  if (!child || child.exitCode !== null && child.exitCode !== undefined) return;
  if (process.platform === 'win32' && child.pid) {
    try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {}
  } else {
    try { child.kill('SIGTERM'); } catch {}
  }
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 5_000);
    child.once('close', () => { clearTimeout(timer); resolve(); });
  });
}

async function removeTemporaryDirectory(directory) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 9) throw error;
      await sleep(100);
    }
  }
}

async function main() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-electron-smoke-'));
  const preferredPort = await getFreePort();
  const args = [`--user-data-dir=${userDataDir}`];
  if (process.platform !== 'win32') args.push('--no-sandbox');
  args.push(repoRoot);
  const child = spawn(electronBinary, args, {
    cwd: repoRoot,
    env: { ...process.env, AB_SMOKE: '1', AB_PORT: String(preferredPort) },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let childOutput = '';
  child.stdout.on('data', (chunk) => { childOutput += chunk.toString().slice(-4_000); });
  child.stderr.on('data', (chunk) => { childOutput += chunk.toString().slice(-4_000); });
  try {
    const ready = await findDesktopBackend(preferredPort);
    const state = await getJson(ready.port, '/api/state?range=day');
    const health = await getJson(ready.port, '/api/health');
    if (state.status !== 200 || !state.body || typeof state.body !== 'object') throw new Error('Electron /api/state smoke check failed');
    if (health.status !== 200 || health.body?.ok !== true || !health.body.diagnostics) {
      throw new Error(`Electron /api/health smoke check failed: status=${health.status}, keys=${Object.keys(health.body || {}).join(',')}`);
    }
    console.log(`Electron smoke passed: port=${ready.port}, runtime=${ready.runtime.runtimeMode}`);
  } catch (error) {
    const logPath = path.join(userDataDir, 'logs', 'desktop.log');
    let desktopLog = '';
    try { desktopLog = fs.readFileSync(logPath, 'utf8').slice(-4_000); } catch {}
    const details = [childOutput.trim(), desktopLog.trim()].filter(Boolean).join('\n');
    throw new Error(`${error.message}${details ? `\nElectron output: ${details}` : ''}`);
  } finally {
    await stopProcessTree(child);
    await removeTemporaryDirectory(userDataDir);
  }
}

main().catch((error) => {
  console.error(`Electron smoke failed: ${error.message || error}`);
  process.exitCode = 1;
});
