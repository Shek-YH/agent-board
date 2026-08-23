const crypto = require('node:crypto');

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function decodeCanonicalBase64url(value) {
  if (!BASE64URL_PATTERN.test(value)) {
    return null;
  }

  const decoded = Buffer.from(value, 'base64url');
  return decoded.toString('base64url') === value ? decoded : null;
}

function normalizeEd25519PublicKey(key) {
  if (key instanceof crypto.KeyObject) {
    return key.type === 'public' && key.asymmetricKeyType === 'ed25519' ? key : null;
  }

  try {
    crypto.createPrivateKey(key);
    return null;
  } catch {
    // Public keys are not accepted by createPrivateKey.
  }

  const publicKey = crypto.createPublicKey(key);

  return publicKey.asymmetricKeyType === 'ed25519' ? publicKey : null;
}

function isValidPayload(payload, config, now) {
  return (
    payload !== null &&
    typeof payload === 'object' &&
    !Array.isArray(payload) &&
    isNonEmptyString(payload.sub) &&
    isNonEmptyString(payload.plan) &&
    Array.isArray(payload.features) &&
    payload.features.every((feature) => typeof feature === 'string') &&
    Number.isFinite(payload.iat) &&
    Number.isFinite(payload.exp) &&
    payload.exp > payload.iat &&
    isNonEmptyString(payload.iss) &&
    payload.iss === config.issuer &&
    isNonEmptyString(payload.aud) &&
    payload.aud === config.audience &&
    isNonEmptyString(payload.jti) &&
    Number.isFinite(now) &&
    payload.exp > now
  );
}

function verifyEntitlement(token, config, now) {
  try {
    if (typeof token !== 'string' || !config || typeof config !== 'object') {
      return null;
    }

    const publicKey = normalizeEd25519PublicKey(config.publicKey);
    if (!publicKey) {
      return null;
    }

    const parts = token.split('.');
    if (parts.length !== 2) {
      return null;
    }

    const [encodedPayload, encodedSignature] = parts;
    const payloadBytes = decodeCanonicalBase64url(encodedPayload);
    const signature = decodeCanonicalBase64url(encodedSignature);
    if (!payloadBytes || !signature) {
      return null;
    }

    if (!crypto.verify(null, Buffer.from(encodedPayload), publicKey, signature)) {
      return null;
    }

    const payload = JSON.parse(payloadBytes.toString('utf8'));
    return isValidPayload(payload, config, now) ? payload : null;
  } catch {
    return null;
  }
}

function hasFeature(entitlement, feature) {
  return Array.isArray(entitlement?.features) && entitlement.features.includes(feature);
}

module.exports = { hasFeature, verifyEntitlement };
