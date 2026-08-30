'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { CloudLicenseClient } = require('./cloud-license-client');
const { isLiteBuild, resolveCloudConfig, shouldConfigureCloud } = require('./build-profile');
const { createSecureStore } = require('./secure-store');

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value, 'utf8').toString('base64'),
    decryptString: (value) => Buffer.from(value.toString('utf8'), 'base64').toString('utf8'),
  };
}

test('安全存储会加密保存、读取和清除对象', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-secure-store-'));
  const filePath = path.join(directory, 'nested', 'cloud-auth.bin');
  try {
    const store = createSecureStore({ safeStorage: fakeSafeStorage(), filePath });
    store.write({ token: 'secret-token' });
    assert.deepEqual(store.read(), { token: 'secret-token' });
    assert.doesNotMatch(fs.readFileSync(filePath, 'utf8'), /secret-token/);
    store.clear();
    assert.equal(store.read(), null);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('构建模式支持普通包云端配置和 lite 包关闭云端', () => {
  const metadata = { build: { extraMetadata: { agentBoardCloudUrl: 'https://cloud.example.test', agentBoardProductId: 'product-1' } } };
  assert.equal(isLiteBuild({ extraMetadata: { agentBoardLiteMode: true } }), true);
  assert.equal(shouldConfigureCloud({ liteMode: false, baseUrl: 'https://cloud.example.test' }), true);
  assert.equal(shouldConfigureCloud({ liteMode: true, baseUrl: 'https://cloud.example.test' }), false);
  assert.deepEqual(resolveCloudConfig({ metadata, env: {} }), {
    baseUrl: 'https://cloud.example.test',
    productId: 'product-1',
    licensePublicKey: null,
  });
});

test('云端客户端无缓存时不发网络请求并返回 signed_out', async () => {
  const store = { read: () => null, write: () => {}, clear: () => {} };
  let fetchCalls = 0;
  const client = new CloudLicenseClient({
    baseUrl: 'https://cloud.example.test',
    secureStore: store,
    fetchImpl: async () => { fetchCalls += 1; throw new Error('unexpected'); },
  });
  assert.deepEqual(await client.getStatus(), {
    state: 'signed_out',
    configured: true,
    authenticated: false,
    hasCachedToken: false,
    features: [],
  });
  assert.equal(fetchCalls, 0);
});

test('云端登录读取 Desktop Auth accessToken 和 refreshToken 并保存账号', async () => {
  let saved;
  let requested;
  const store = {
    read: () => saved || null,
    write: (value) => { saved = value; },
    clear: () => { saved = null; },
  };
  const client = new CloudLicenseClient({
    baseUrl: 'https://cloud.example.test/',
    secureStore: store,
    fetchImpl: async (url, options) => {
      requested = { url: String(url), options };
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({
          accessToken: 'access-token',
          accessTokenExpiresAt: '2026-08-30T12:15:00.000Z',
          refreshToken: 'refresh-token',
          refreshTokenExpiresAt: '2026-09-29T12:00:00.000Z',
          user: { id: 'user-1', email: 'user@example.test' },
        }),
      };
    },
  });
  const result = await client.login('user@example.test', 'password');
  assert.deepEqual(result.user, { id: 'user-1', email: 'user@example.test' });
  assert.equal(saved.token, 'access-token');
  assert.equal(saved.accessToken, 'access-token');
  assert.equal(saved.refreshToken, 'refresh-token');
  assert.equal(requested.url, 'https://cloud.example.test/v1/desktop/auth/login');
  assert.deepEqual(JSON.parse(requested.options.body), { email: 'user@example.test', password: 'password' });
});

test('云端注册读取 Desktop Auth accessToken，不能因缺少旧 token 字段误报 session token', async () => {
  let saved;
  let requested;
  const store = {
    read: () => saved || null,
    write: (value) => { saved = value; },
    clear: () => { saved = null; },
  };
  const client = new CloudLicenseClient({
    baseUrl: 'https://cloud.example.test',
    secureStore: store,
    fetchImpl: async (url, options) => {
      requested = { url: String(url), options };
      return {
        ok: true,
        status: 201,
        headers: { get: () => null },
        text: async () => JSON.stringify({
          accessToken: 'registered-access-token',
          accessTokenExpiresAt: '2026-08-30T12:15:00.000Z',
          refreshToken: 'registered-refresh-token',
          refreshTokenExpiresAt: '2026-09-29T12:00:00.000Z',
          user: { id: 'user-2', email: 'new-user@example.test' },
        }),
      };
    },
  });

  const result = await client.register('new-user@example.test', 'password', 'ABCD-1234');
  assert.deepEqual(result.user, { id: 'user-2', email: 'new-user@example.test' });
  assert.equal(saved.token, 'registered-access-token');
  assert.equal(saved.refreshToken, 'registered-refresh-token');
  assert.equal(requested.url, 'https://cloud.example.test/v1/registration/register');
});

test('云端刷新轮换 Desktop Auth refreshToken 并更新 accessToken', async () => {
  let saved = { token: 'old-access-token', refreshToken: 'old-refresh-token' };
  const store = {
    read: () => saved,
    write: (value) => { saved = value; },
    clear: () => { saved = null; },
  };
  const client = new CloudLicenseClient({
    baseUrl: 'https://cloud.example.test',
    secureStore: store,
    fetchImpl: async (url, options) => {
      assert.equal(String(url), 'https://cloud.example.test/v1/desktop/auth/refresh');
      assert.deepEqual(JSON.parse(options.body), { refreshToken: 'old-refresh-token' });
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({
          accessToken: 'new-access-token',
          refreshToken: 'new-refresh-token',
          user: { id: 'user-1', email: 'user@example.test' },
        }),
      };
    },
  });

  await client.refresh();
  assert.equal(saved.token, 'new-access-token');
  assert.equal(saved.refreshToken, 'new-refresh-token');
});
