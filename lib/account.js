const { loadAuthCache } = require('./auth-cache');
const { hasFeature, verifyEntitlement } = require('./entitlement');

function configuredAuth(env) {
  const audience = env.AGENT_BOARD_AUTH_AUDIENCE;
  const issuer = env.AGENT_BOARD_AUTH_ISSUER;
  const publicKey = env.AGENT_BOARD_AUTH_PUBLIC_KEY;

  if (![audience, issuer, publicKey].every((value) => typeof value === 'string' && value.length > 0)) {
    return null;
  }

  return { audience, issuer, publicKey };
}

function freeStatus(configured, hasCachedToken) {
  return {
    account: null,
    configured,
    features: [],
    hasCachedToken,
    state: configured ? 'free' : 'unconfigured',
  };
}

function getAccountStatus(options = {}) {
  const env = options.env || process.env;
  const cache = loadAuthCache(options.cachePath);
  const config = configuredAuth(env);
  const hasCachedToken = cache !== null;

  if (!config) {
    return freeStatus(false, hasCachedToken);
  }

  const entitlement = cache && verifyEntitlement(cache.token, config, options.now ?? Date.now());
  if (!entitlement) {
    return freeStatus(true, hasCachedToken);
  }

  return {
    account: { expiresAt: entitlement.exp, id: entitlement.sub, plan: entitlement.plan },
    configured: true,
    features: [...entitlement.features],
    hasCachedToken: true,
    state: 'active',
  };
}

function hasAccountFeature(status, feature) {
  return status?.state === 'active' && hasFeature(status, feature);
}

module.exports = { getAccountStatus, hasAccountFeature };
