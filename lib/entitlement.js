const crypto = require('node:crypto');

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
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

    const parts = token.split('.');
    if (
      parts.length !== 2 ||
      !BASE64URL_PATTERN.test(parts[0]) ||
      !BASE64URL_PATTERN.test(parts[1])
    ) {
      return null;
    }

    const [encodedPayload, encodedSignature] = parts;
    const signature = Buffer.from(encodedSignature, 'base64url');
    if (!crypto.verify(null, Buffer.from(encodedPayload), config.publicKey, signature)) {
      return null;
    }

    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
    return isValidPayload(payload, config, now) ? payload : null;
  } catch {
    return null;
  }
}

function hasFeature(entitlement, feature) {
  return Array.isArray(entitlement?.features) && entitlement.features.includes(feature);
}

module.exports = { hasFeature, verifyEntitlement };
