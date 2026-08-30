'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createHookAuth,
  authorizeHookRequest,
  createHookUrl,
  readJsonBody,
  writeHookConfig,
} = require('./workbuddy-http');

function request({ address = '127.0.0.1', authorization, body = '' } = {}) {
  const req = new EventEmitter();
  req.headers = authorization ? { authorization } : {};
  req.socket = { remoteAddress: address };
  process.nextTick(() => {
    req.emit('data', Buffer.from(body));
    req.emit('end');
  });
  return req;
}

test('HTTP Hook 只接受 loopback Bearer token，并生成不泄漏 token 的 URL', () => {
  const token = 'a'.repeat(64);
  assert.equal(authorizeHookRequest(request({ authorization: `Bearer ${token}` }), token), true);
  assert.equal(authorizeHookRequest(request({ address: '192.168.1.20', authorization: `Bearer ${token}` }), token), false);
  assert.equal(authorizeHookRequest(request({ authorization: 'Bearer wrong' }), token), false);
  assert.equal(createHookUrl({ port: 4876 }), 'http://127.0.0.1:4876/internal/hooks/workbuddy');
  assert.equal(createHookUrl({ port: 4876, path: '/internal/hooks/workbuddy/x' }), 'http://127.0.0.1:4876/internal/hooks/workbuddy/x');
});

test('HTTP Hook token 优先使用强度足够的环境配置，否则生成随机 token', () => {
  const configured = createHookAuth({ env: { AGENT_BOARD_WORKBUDDY_HTTP_TOKEN: 'b'.repeat(64) } });
  assert.equal(configured.token, 'b'.repeat(64));
  assert.equal(configured.source, 'environment');
  const generated = createHookAuth({ env: {}, randomBytes: (size) => Buffer.alloc(size, 7) });
  assert.equal(generated.token, '07'.repeat(32));
  assert.equal(generated.source, 'ephemeral');
});

test('HTTP Hook JSON body 有大小上限并拒绝非法 JSON', async () => {
  await assert.rejects(readJsonBody(request({ body: '{bad' })), /invalid json/i);
  await assert.rejects(readJsonBody(request({ body: 'x'.repeat(20) }), { maxBytes: 10 }), (error) => error.statusCode === 413);
  assert.deepEqual(await readJsonBody(request({ body: '{"event":"Stop"}' })), { event: 'Stop' });
});

test('HTTP Hook 配置写入私有目录，供 command fallback 读取', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-workbuddy-http-config-'));
  const filePath = path.join(root, 'nested', 'http-hook.json');
  try {
    assert.equal(writeHookConfig(filePath, {
      url: 'http://127.0.0.1:4876/internal/hooks/workbuddy',
      token: 'c'.repeat(64),
    }), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), {
      url: 'http://127.0.0.1:4876/internal/hooks/workbuddy',
      token: 'c'.repeat(64),
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
