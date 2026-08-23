const assert = require('node:assert/strict');
const { generateKeyPairSync, sign } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { getAccountStatus, hasAccountFeature } = require('./account');
const { saveAuthCache } = require('./auth-cache');

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const env = {
  AGENT_BOARD_AUTH_AUDIENCE: 'agent-board',
  AGENT_BOARD_AUTH_ISSUER: 'https://account.example.com',
  AGENT_BOARD_AUTH_PUBLIC_KEY: publicKey.export({ format: 'pem', type: 'spki' }),
};

function createCachePath() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-account-'));
  return { directory, cachePath: path.join(directory, 'auth.json') };
}

function createToken(overrides = {}) {
  const payload = {
    aud: env.AGENT_BOARD_AUTH_AUDIENCE,
    exp: 2_000,
    features: ['team-sync'],
    iat: 1_000,
    iss: env.AGENT_BOARD_AUTH_ISSUER,
    jti: 'token-1',
    plan: 'pro',
    sub: 'user-1',
    ...overrides,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = sign(null, Buffer.from(encodedPayload), privateKey).toString('base64url');
  return `${encodedPayload}.${signature}`;
}

test('未配置云端时返回 unconfigured 且不授予权益', () => {
  const { directory, cachePath } = createCachePath();
  try {
    assert.deepEqual(getAccountStatus({ cachePath, env: {}, now: 1_500 }), {
      account: null,
      configured: false,
      features: [],
      hasCachedToken: false,
      state: 'unconfigured',
    });
  } finally {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

test('云端已配置但没有缓存时返回免费状态', () => {
  const { directory, cachePath } = createCachePath();
  try {
    assert.deepEqual(getAccountStatus({ cachePath, env, now: 1_500 }), {
      account: null,
      configured: true,
      features: [],
      hasCachedToken: false,
      state: 'free',
    });
  } finally {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

test('有效缓存只暴露账号安全摘要与权益', () => {
  const { directory, cachePath } = createCachePath();
  try {
    saveAuthCache({ token: createToken(), receivedAt: 1_100 }, cachePath);
    const status = getAccountStatus({ cachePath, env, now: 1_500 });

    assert.deepEqual(status, {
      account: { expiresAt: 2_000, id: 'user-1', plan: 'pro' },
      configured: true,
      features: ['team-sync'],
      hasCachedToken: true,
      state: 'active',
    });
    assert.equal(Object.hasOwn(status, 'token'), false);
    assert.equal(hasAccountFeature(status, 'team-sync'), true);
    assert.equal(hasAccountFeature(status, 'board:read'), false);
  } finally {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

test('无效缓存降级为免费状态但保留清除提示', () => {
  const { directory, cachePath } = createCachePath();
  try {
    saveAuthCache({ token: 'invalid-token', receivedAt: 1_100 }, cachePath);

    assert.deepEqual(getAccountStatus({ cachePath, env, now: 1_500 }), {
      account: null,
      configured: true,
      features: [],
      hasCachedToken: true,
      state: 'free',
    });
  } finally {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});
