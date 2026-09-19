'use strict';

class ConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigurationError';
    this.code = 'INVALID_CONFIGURATION';
    this.statusCode = 500;
  }
}

function nonBlank(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parsePort(value) {
  const port = Number(value || 3200);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigurationError('PORT must be an integer between 1 and 65535');
  }
  return port;
}

function parseApiHost(value) {
  const host = nonBlank(value) || '127.0.0.1';
  if (!['127.0.0.1', '::1', '0.0.0.0', '::'].includes(host)) {
    throw new ConfigurationError('API_HOST must be a loopback or explicit wildcard address');
  }
  return host;
}

function validateUrl(value, name, { httpsOnly = false } = {}) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || (httpsOnly && url.protocol !== 'https:')) {
      throw new Error();
    }
    return url.origin;
  } catch {
    throw new ConfigurationError(`${name} must be a valid ${httpsOnly ? 'HTTPS ' : ''}origin`);
  }
}

function loadConfig(env = process.env) {
  const nodeEnv = nonBlank(env.NODE_ENV) || 'development';
  const missing = ['DATABASE_URL', 'BETTER_AUTH_SECRET', 'BETTER_AUTH_URL', 'REDEMPTION_PEPPER']
    .filter((name) => !nonBlank(env[name]));
  if (missing.length) {
    throw new ConfigurationError(`Missing required configuration: ${missing.join(', ')}`);
  }

  const betterAuthSecret = nonBlank(env.BETTER_AUTH_SECRET);
  if (betterAuthSecret.length < 32) {
    throw new ConfigurationError('BETTER_AUTH_SECRET must contain at least 32 characters');
  }

  const redemptionPepper = nonBlank(env.REDEMPTION_PEPPER);
  if (redemptionPepper.length < 32) {
    throw new ConfigurationError('REDEMPTION_PEPPER must contain at least 32 characters');
  }
  if (nodeEnv === 'production' && /^(change-me|secret|test[-_])/i.test(redemptionPepper)) {
    throw new ConfigurationError('REDEMPTION_PEPPER must not use a development placeholder');
  }
  if (nodeEnv === 'production' && /^(change-me|secret|test[-_])/i.test(betterAuthSecret)) {
    throw new ConfigurationError('BETTER_AUTH_SECRET must not use a development placeholder');
  }

  const betterAuthUrl = validateUrl(env.BETTER_AUTH_URL, 'BETTER_AUTH_URL', {
    httpsOnly: nodeEnv === 'production',
  });
  const adminOrigin = validateUrl(
    nonBlank(env.ADMIN_ORIGIN) || 'http://127.0.0.1:3100',
    'ADMIN_ORIGIN',
    { httpsOnly: nodeEnv === 'production' },
  );
  const trustedOrigins = (nonBlank(env.TRUSTED_ORIGINS) || adminOrigin)
    .split(',')
    .map((origin) => validateUrl(origin.trim(), 'TRUSTED_ORIGINS', { httpsOnly: nodeEnv === 'production' }));

  return {
    nodeEnv,
    port: parsePort(env.PORT),
    apiHost: parseApiHost(env.API_HOST),
    databaseUrl: nonBlank(env.DATABASE_URL),
    betterAuthSecret,
    betterAuthUrl,
    redemptionPepper,
    licenseSigningPrivateKey: nonBlank(env.LICENSE_SIGNING_PRIVATE_KEY),
    licenseSigningKeyId: nonBlank(env.LICENSE_SIGNING_KEY_ID) || 'primary',
    adminOrigin,
    trustedOrigins,
  };
}

function toSafeConfig(config) {
  return {
    nodeEnv: config.nodeEnv,
    port: config.port,
    apiHost: config.apiHost,
    betterAuthUrl: config.betterAuthUrl,
    adminOrigin: config.adminOrigin,
    trustedOrigins: [...config.trustedOrigins],
  };
}

module.exports = { ConfigurationError, loadConfig, toSafeConfig };
