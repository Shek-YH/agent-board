'use strict';

function buildAuthConfig(config) {
  return {
    secret: config.betterAuthSecret,
    baseURL: config.betterAuthUrl,
    trustedOrigins: [...config.trustedOrigins],
    emailAndPassword: { enabled: true },
    advanced: { useSecureCookies: config.nodeEnv === 'production' },
  };
}

module.exports = { buildAuthConfig };
