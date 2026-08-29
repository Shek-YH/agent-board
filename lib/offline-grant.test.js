'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const { verifyOfflineGrant } = require('./offline-grant');
const { createOfflineGrantService } = require('../cloud/apps/api/src/offline-grant.service');

test('client verifies a server-signed Offline Grant and rejects tampering', () => {
  const pair = crypto.generateKeyPairSync('ed25519');
  const issuedAt = new Date('2026-08-28T12:00:00.000Z');
  const service = createOfflineGrantService({ privateKey: pair.privateKey, keyId: 'root-test' });
  const token = service.issue({
    userId: 'user-1',
    deviceId: 'device-1',
    productId: 'product-1',
    features: { chat: true },
    entitlementExpiresAt: new Date('2026-08-29T12:00:00.000Z'),
    offlineGraceSeconds: 3600,
    issuedAt,
  });

  const result = verifyOfflineGrant(token, { publicKey: pair.publicKey }, { now: issuedAt.getTime() / 1000, clockSkewSeconds: 0 });
  assert.ok(result);
  assert.equal(result.grant.productId, 'product-1');

  const [payload, signature] = token.split('.');
  const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  decoded.deviceId = 'other-device';
  const tamperedPayload = Buffer.from(JSON.stringify(decoded)).toString('base64url');
  assert.equal(verifyOfflineGrant(`${tamperedPayload}.${signature}`, { publicKey: pair.publicKey }, { now: issuedAt.getTime() / 1000, clockSkewSeconds: 0 }), null);
});
