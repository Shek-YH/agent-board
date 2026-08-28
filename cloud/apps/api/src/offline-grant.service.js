'use strict';

const crypto = require('node:crypto');

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  return value;
}

function parseDate(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('Invalid Offline Grant date');
  return date;
}

function assertText(value, name, maximum = 255) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximum) throw new Error(`Invalid Offline Grant ${name}`);
  return value.trim();
}

function privateKeyObject(value) {
  try {
    const key = value instanceof crypto.KeyObject ? value : crypto.createPrivateKey(value);
    if (key.type !== 'private' || key.asymmetricKeyType !== 'ed25519') throw new Error();
    return key;
  } catch {
    try {
      const key = crypto.createPrivateKey({ key: Buffer.from(String(value), 'base64'), format: 'der', type: 'pkcs8' });
      if (key.type !== 'private' || key.asymmetricKeyType !== 'ed25519') throw new Error();
      return key;
    } catch {
      const error = new Error('LICENSE_SIGNING_PRIVATE_KEY must be an Ed25519 private key');
      error.code = 'INVALID_LICENSE_SIGNING_KEY';
      throw error;
    }
  }
}

function encode(value) {
  return Buffer.from(value).toString('base64url');
}

function createOfflineGrant(payload, privateKey) {
  const key = privateKeyObject(privateKey);
  const encodedPayload = encode(JSON.stringify(canonicalize(payload)));
  const signature = crypto.sign(null, Buffer.from(encodedPayload, 'utf8'), key).toString('base64url');
  return `${encodedPayload}.${signature}`;
}

/**
 * @param {{ privateKey?: unknown, keyId?: string, clock?: () => Date }} [options]
 */
function createOfflineGrantService({ privateKey, keyId = 'primary', clock = () => new Date() } = {}) {
  const key = privateKey ? privateKeyObject(privateKey) : null;
  const kid = assertText(keyId, 'key id', 64);
  return {
    issue(input = {}) {
      if (!key) return null;
      const issuedAt = parseDate(input.issuedAt || clock());
      const graceSeconds = Number(input.offlineGraceSeconds || 0);
      if (!Number.isSafeInteger(graceSeconds) || graceSeconds < 1) return null;
      const offlineValidUntil = new Date(issuedAt.getTime() + graceSeconds * 1000);
      const entitlementExpiresAt = input.entitlementExpiresAt == null ? null : parseDate(input.entitlementExpiresAt);
      const effectiveUntil = entitlementExpiresAt && entitlementExpiresAt < offlineValidUntil ? entitlementExpiresAt : offlineValidUntil;
      if (effectiveUntil <= issuedAt) return null;
      if (!input.features || typeof input.features !== 'object' || Array.isArray(input.features)) throw new Error('Invalid Offline Grant features');
      const payload = {
        type: 'OFFLINE_GRANT',
        kid,
        jti: crypto.randomUUID(),
        userId: assertText(input.userId, 'user id'),
        deviceId: assertText(input.deviceId, 'device id'),
        productId: assertText(input.productId, 'product id'),
        features: canonicalize(input.features),
        entitlementExpiresAt: entitlementExpiresAt?.toISOString() || null,
        offlineValidUntil: offlineValidUntil.toISOString(),
        issuedAt: issuedAt.toISOString(),
        policyVersion: assertText(input.policyVersion || 'default', 'policy version', 128),
      };
      return createOfflineGrant(payload, key);
    },
  };
}

module.exports = { createOfflineGrant, createOfflineGrantService, canonicalize, privateKeyObject };
