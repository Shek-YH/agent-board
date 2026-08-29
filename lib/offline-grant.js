const crypto = require('node:crypto');

function decodeCanonicalBase64url(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const decoded = Buffer.from(value, 'base64url');
  return decoded.toString('base64url') === value ? decoded : null;
}

function publicKeyObject(value) {
  try {
    let key;
    if (value instanceof crypto.KeyObject) key = value;
    else {
      try {
        key = crypto.createPublicKey(value);
      } catch {
        key = crypto.createPublicKey({ key: Buffer.from(String(value), 'base64'), format: 'der', type: 'spki' });
      }
    }
    return key.type === 'public' && key.asymmetricKeyType === 'ed25519' ? key : null;
  } catch {
    return null;
  }
}

function seconds(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value > 100000000000 ? value / 1000 : value;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.getTime() / 1000;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function verifyOfflineGrant(token, config, { now = Date.now() / 1000, state = {}, clockSkewSeconds = 300 } = {}) {
  try {
    if (typeof token !== 'string' || !isPlainObject(config)) return null;
    const key = publicKeyObject(config.publicKey);
    if (!key) return null;
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [encodedPayload, encodedSignature] = parts;
    const payloadBytes = decodeCanonicalBase64url(encodedPayload);
    const signature = decodeCanonicalBase64url(encodedSignature);
    if (!payloadBytes || !signature || !crypto.verify(null, Buffer.from(encodedPayload, 'utf8'), key, signature)) return null;
    const grant = JSON.parse(payloadBytes.toString('utf8'));
    if (!isPlainObject(grant) || grant.type !== 'OFFLINE_GRANT' || !['userId', 'deviceId', 'productId', 'kid', 'jti', 'policyVersion'].every((field) => typeof grant[field] === 'string' && grant[field])) return null;
    if (!isPlainObject(grant.features)) return null;
    const issuedAt = seconds(grant.issuedAt);
    const offlineValidUntil = seconds(grant.offlineValidUntil);
    const entitlementExpiresAt = grant.entitlementExpiresAt == null ? Infinity : seconds(grant.entitlementExpiresAt);
    const nowSeconds = seconds(now);
    if (![issuedAt, offlineValidUntil, nowSeconds].every((value) => Number.isFinite(value))) return null;
    if (entitlementExpiresAt !== Infinity && !Number.isFinite(entitlementExpiresAt)) return null;
    if (offlineValidUntil <= issuedAt || nowSeconds + clockSkewSeconds < issuedAt) return null;
    const validUntil = Math.min(entitlementExpiresAt, offlineValidUntil);
    if (validUntil <= nowSeconds) return null;
    const previousMax = Number.isFinite(Number(state.maxSeenTime)) ? Number(state.maxSeenTime) : 0;
    if (nowSeconds + clockSkewSeconds < previousMax) return null;
    return {
      grant,
      validUntil,
      nextState: { ...state, maxSeenTime: Math.max(previousMax, nowSeconds) },
    };
  } catch {
    return null;
  }
}

module.exports = { verifyOfflineGrant };
