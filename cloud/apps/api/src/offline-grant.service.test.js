'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const { createOfflineGrantService } = require('./offline-grant.service');
const { verifyOfflineGrant } = require('../../../../lib/offline-grant');

const now = new Date('2026-08-28T12:00:00.000Z');

function keyPair() {
  return crypto.generateKeyPairSync('ed25519');
}

function grantInput(overrides = {}) {
  return {
    userId: 'user-1',
    deviceId: 'device-1',
    productId: 'product-1',
    features: { claude: true },
    entitlementExpiresAt: new Date('2026-09-28T12:00:00.000Z'),
    offlineGraceSeconds: 3600,
    policyVersion: 'policy-1',
    issuedAt: now,
    ...overrides,
  };
}

test('server signed Offline Grant is verified by the client and caps validity at entitlement expiry', () => {
  const pair = keyPair();
  const service = createOfflineGrantService({ privateKey: pair.privateKey, keyId: 'license-key-1' });
  const token = service.issue(grantInput({ offlineGraceSeconds: 4_000_000 }));
  const result = verifyOfflineGrant(token, { publicKey: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64') }, { now: now.getTime() / 1000, clockSkewSeconds: 0 });

  assert.ok(result);
  assert.equal(result.grant.userId, 'user-1');
  assert.equal(result.grant.deviceId, 'device-1');
  assert.equal(result.grant.kid, 'license-key-1');
  assert.equal(result.validUntil, new Date('2026-09-28T12:00:00.000Z').getTime() / 1000);
});

test('tampering with Offline Grant payload or using it after grace expiry fails signature/expiry checks', () => {
  const pair = keyPair();
  const service = createOfflineGrantService({ privateKey: pair.privateKey, keyId: 'license-key-1' });
  const token = service.issue(grantInput({ entitlementExpiresAt: null, offlineGraceSeconds: 60 }));
  const [encodedPayload, signature] = token.split('.');
  const tamperedPayload = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')), deviceId: 'other-device' })).toString('base64url');

  assert.equal(verifyOfflineGrant(`${tamperedPayload}.${signature}`, { publicKey: pair.publicKey }, { now: now.getTime() / 1000, clockSkewSeconds: 0 }), null);
  assert.equal(verifyOfflineGrant(token, { publicKey: pair.publicKey }, { now: now.getTime() / 1000 + 61, clockSkewSeconds: 0 }), null);
  assert.equal(service.issue(grantInput({ offlineGraceSeconds: 0 })), null);
});

test('Offline Grant verifier rejects local clock rollback beyond the persisted maximum seen time', () => {
  const pair = keyPair();
  const service = createOfflineGrantService({ privateKey: pair.privateKey, keyId: 'license-key-1' });
  const token = service.issue(grantInput({ entitlementExpiresAt: null, offlineGraceSeconds: 3600 }));
  const first = verifyOfflineGrant(token, { publicKey: pair.publicKey }, { now: now.getTime() / 1000 + 600, clockSkewSeconds: 0 });
  const rollback = verifyOfflineGrant(token, { publicKey: pair.publicKey }, { now: now.getTime() / 1000 + 30, state: first.nextState, clockSkewSeconds: 0 });

  assert.ok(first);
  assert.equal(rollback, null);
});
