'use strict';

const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const exePath = path.resolve(process.argv[2] || 'dist/fixed/win-unpacked/Agent Board.exe');
const expectedServerRoot = path.resolve(path.dirname(exePath), 'resources', 'backend');
const profilePath = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-exe-startup-'));
const dataPath = path.join(profilePath, 'data');
const child = spawn(exePath, [`--user-data-dir=${profilePath}`], {
  cwd: path.dirname(exePath),
  env: { ...process.env, AB_DATA_DIR: dataPath, AGENT_BOARD_CLOUD_URL: 'http://127.0.0.1:9' },
  stdio: 'ignore',
  windowsHide: true,
});

let finished = false;
const deadline = Date.now() + 20000;

function cleanup() {
  try {
    execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } catch {}
  try {
    fs.rmSync(profilePath, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch {
    // Windows may release Electron's profile lock just after the process tree exits.
  }
}

function finish(code, message) {
  if (finished) return;
  finished = true;
  if (message) console.log(message);
  cleanup();
  process.exit(code);
}

child.once('error', (error) => finish(1, `exe spawn error: ${error.message}`));
child.once('exit', (code) => {
  if (!finished) finish(1, `exe exited before backend readiness: ${code}`);
});

function retry() {
  if (finished) return;
  if (Date.now() >= deadline) {
    finish(1, 'fixed EXE did not start its backend within 20 seconds');
    return;
  }
  setTimeout(probe, 300);
}

function probe() {
  if (finished) return;
  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(path.join(dataPath, '.runtime.json'), 'utf8'));
  } catch {
    retry();
    return;
  }
  const port = Number(marker?.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    retry();
    return;
  }
  const request = http.get(`http://127.0.0.1:${port}/api/state`, { timeout: 2000 }, (response) => {
    let body = '';
    response.setEncoding('utf8');
    response.on('data', (chunk) => { body += chunk; });
    response.on('end', () => {
      try {
        if (response.statusCode !== 200) throw new Error(`HTTP ${response.statusCode}`);
        const runtime = JSON.parse(body).runtime || {};
        const normalizedRoot = String(runtime.serverRoot || '').toLowerCase().replaceAll('/', '\\');
        const normalizedExpectedRoot = expectedServerRoot.toLowerCase().replaceAll('/', '\\');
        if (runtime.runtimeMode !== 'desktop' || runtime.port !== port || normalizedRoot !== normalizedExpectedRoot) {
          throw new Error(`unexpected packaged runtime identity: expected=${normalizedExpectedRoot} actual=${normalizedRoot}`);
        }
        finish(0, JSON.stringify({ exeStarted: true, httpStatus: response.statusCode, runtimeMode: runtime.runtimeMode, serverRoot: runtime.serverRoot }));
      } catch (error) {
        finish(1, error.message);
      }
    });
  });
  request.once('error', retry);
  request.once('timeout', () => { request.destroy(); retry(); });
}

probe();
