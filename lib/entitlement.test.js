const assert = require('node:assert/strict');
const { generateKeyPairSync, sign } = require('node:crypto');
const test = require('node:test');

const { hasFeature, verifyEntitlement } = require('./entitlement');

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const config = {
  audience: 'agent-board',
  issuer: 'agent-board-auth',
  publicKey,
};

function createToken(overrides = {}) {
  const payload = {
    aud: config.audience,
    exp: 2_000,
    features: ['board:read', 'board:write'],
    iat: 1_000,
    iss: config.issuer,
    jti: 'token-1',
    plan: 'pro',
    sub: 'user-1',
    ...overrides,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = sign(null, Buffer.from(encodedPayload), privateKey).toString('base64url');

  return `${encodedPayload}.${signature}`;
}

test('验证有效的 Ed25519 权益令牌并返回 payload', () => {
  const token = createToken();

  assert.deepEqual(verifyEntitlement(token, config, 1_500), {
    aud: config.audience,
    exp: 2_000,
    features: ['board:read', 'board:write'],
    iat: 1_000,
    iss: config.issuer,
    jti: 'token-1',
    plan: 'pro',
    sub: 'user-1',
  });
});

test('拒绝签名被篡改的令牌', () => {
  const [encodedPayload, encodedSignature] = createToken().split('.');
  const signature = Buffer.from(encodedSignature, 'base64url');
  signature[0] ^= 1;

  assert.equal(
    verifyEntitlement(`${encodedPayload}.${signature.toString('base64url')}`, config, 1_500),
    null,
  );
});

test('拒绝已过期的令牌', () => {
  assert.equal(verifyEntitlement(createToken({ exp: 1_500 }), config, 1_500), null);
});

test('拒绝 issuer 不匹配的令牌', () => {
  assert.equal(verifyEntitlement(createToken({ iss: 'other-issuer' }), config, 1_500), null);
});

test('拒绝 audience 不匹配的令牌', () => {
  assert.equal(verifyEntitlement(createToken({ aud: 'other-audience' }), config, 1_500), null);
});

test('拒绝缺少 features 的令牌', () => {
  assert.equal(verifyEntitlement(createToken({ features: undefined }), config, 1_500), null);
});

test('hasFeature 仅在 features 包含目标特性时返回 true', () => {
  const entitlement = verifyEntitlement(createToken(), config, 1_500);

  assert.equal(hasFeature(entitlement, 'board:read'), true);
  assert.equal(hasFeature(entitlement, 'board:admin'), false);
  assert.equal(hasFeature(null, 'board:read'), false);
  assert.equal(hasFeature({ features: 'board:read' }, 'board:read'), false);
});
