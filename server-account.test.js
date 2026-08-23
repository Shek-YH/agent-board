const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = __dirname;

function request(port, pathname, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', method, path: pathname, port }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ body, statusCode: res.statusCode }));
    });
    req.on('error', reject);
    req.end();
  });
}

function openPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function startServer(directory) {
  const port = await openPort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, AB_PORT: String(port), LOCALAPPDATA: directory, USERPROFILE: directory },
    stdio: 'ignore',
    windowsHide: true,
  });

  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await request(port, '/api/account/status');
      if (response.statusCode === 200) return { child, port };
    } catch {
      // The server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  await stopServer(child);
  throw new Error('account test server did not start');
}

function stopServer(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }

    const timeout = setTimeout(() => child.kill('SIGKILL'), 2_000);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill();
  });
}

test('账户状态和退出 API 不泄漏令牌，且删除错误返回 500 不终止服务', async () => {
  const goodDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-account-api-'));
  const badDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-account-api-'));
  let goodServer;
  let badServer;

  try {
    const goodCachePath = path.join(goodDirectory, 'AgentBoard', 'auth.json');
    fs.mkdirSync(path.dirname(goodCachePath), { recursive: true });
    fs.writeFileSync(goodCachePath, JSON.stringify({ token: 'cached-token', receivedAt: 1 }), 'utf8');
    goodServer = await startServer(goodDirectory);

    const beforeLogout = await request(goodServer.port, '/api/account/status');
    assert.equal(beforeLogout.statusCode, 200);
    assert.equal(JSON.parse(beforeLogout.body).hasCachedToken, true);
    assert.equal(beforeLogout.body.includes('cached-token'), false);

    const logout = await request(goodServer.port, '/api/account/logout', 'POST');
    assert.equal(logout.statusCode, 200);
    assert.equal(JSON.parse(logout.body).hasCachedToken, false);
    assert.equal(fs.existsSync(goodCachePath), false);

    const badCachePath = path.join(badDirectory, 'AgentBoard', 'auth.json');
    fs.mkdirSync(badCachePath, { recursive: true });
    badServer = await startServer(badDirectory);

    const failedLogout = await request(badServer.port, '/api/account/logout', 'POST');
    assert.equal(failedLogout.statusCode, 500);
    assert.equal(JSON.parse(failedLogout.body).error, 'Unable to clear account cache');
    assert.equal((await request(badServer.port, '/api/account/status')).statusCode, 200);
  } finally {
    if (goodServer) await stopServer(goodServer.child);
    if (badServer) await stopServer(badServer.child);
    fs.rmSync(goodDirectory, { force: true, recursive: true });
    fs.rmSync(badDirectory, { force: true, recursive: true });
  }
});
