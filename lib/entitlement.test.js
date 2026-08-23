const assert = require('node:assert/strict');
const { generateKeyPairSync, sign } = require('node:crypto');
const test = require('node:test');

const { hasFeature, verifyEntitlement } = require('./entitlement');

const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const config = {
  audience: 'agent-board',
  issuer: 'agent-board-auth',
  publicKey,
};

function createToken(overrides = {}, signingKey = privateKey) {
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
  const signature = sign(null, Buffer.from(encodedPayload), signingKey).toString('base64url');

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

test('接受 Ed25519 公钥 PEM', () => {
  const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' });

  assert.equal(verifyEntitlement(createToken(), { ...config, publicKey: publicKeyPem }, 1_500).sub, 'user-1');
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

test('拒绝使用 Ed448 公钥签发的令牌', () => {
  const ed448 = generateKeyPairSync('ed448');
  const ed448Config = { ...config, publicKey: ed448.publicKey };

  assert.equal(verifyEntitlement(createToken({}, ed448.privateKey), ed448Config, 1_500), null);
});

test('拒绝签名使用非规范 base64url 尾位的令牌', () => {
  const token = createToken();
  const [encodedPayload, encodedSignature] = token.split('.');
  assert.equal(encodedSignature.length, 86);
  const finalCharacterIndex = BASE64URL_ALPHABET.indexOf(encodedSignature.at(-1));
  assert.equal(finalCharacterIndex % 16, 0);
  const nonCanonicalSignature = `${encodedSignature.slice(0, -1)}${BASE64URL_ALPHABET[finalCharacterIndex + 1]}`;
  assert.deepEqual(
    Buffer.from(nonCanonicalSignature, 'base64url'),
    Buffer.from(encodedSignature, 'base64url'),
  );

  assert.equal(
    verifyEntitlement(
      `${encodedPayload}.${nonCanonicalSignature}`,
      config,
      1_500,
    ),
    null,
  );
});

test('拒绝 Ed25519 私钥 KeyObject 作为 publicKey', () => {
  assert.equal(verifyEntitlement(createToken(), { ...config, publicKey: privateKey }, 1_500), null);
});

test('拒绝 Ed25519 PKCS#8 私钥 PEM 作为 publicKey', () => {
  const privateKeyPem = privateKey.export({ format: 'pem', type: 'pkcs8' });

  assert.equal(verifyEntitlement(createToken(), { ...config, publicKey: privateKeyPem }, 1_500), null);
});

test('拒绝签名覆盖的非规范 payload base64url 编码', () => {
  const [encodedPayload] = createToken().split('.');
  assert.equal(encodedPayload.length % 4, 3);
  const finalCharacterIndex = BASE64URL_ALPHABET.indexOf(encodedPayload.at(-1));
  assert.equal(finalCharacterIndex % 4, 0);
  const nonCanonicalPayload = `${encodedPayload.slice(0, -1)}${BASE64URL_ALPHABET[finalCharacterIndex + 1]}`;
  const signature = sign(null, Buffer.from(nonCanonicalPayload), privateKey).toString('base64url');

  assert.deepEqual(
    Buffer.from(nonCanonicalPayload, 'base64url'),
    Buffer.from(encodedPayload, 'base64url'),
  );
  assert.equal(verifyEntitlement(`${nonCanonicalPayload}.${signature}`, config, 1_500), null);
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
