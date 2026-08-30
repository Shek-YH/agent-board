const test = require('node:test');
const assert = require('node:assert/strict');

const { ConfigurationError, loadConfig, toSafeConfig } = require('./config');

const VALID_ENV = {
  NODE_ENV: 'test',
  PORT: '3201',
  DATABASE_URL: 'postgresql://agent_board:test@127.0.0.1:5432/agent_board',
  BETTER_AUTH_SECRET: 'test-secret-that-is-at-least-32-characters-long',
  BETTER_AUTH_URL: 'http://127.0.0.1:3201',
  REDEMPTION_PEPPER: 'test-redemption-pepper-that-is-at-least-32-characters',
  ADMIN_ORIGIN: 'http://127.0.0.1:3101',
  TRUSTED_ORIGINS: 'http://127.0.0.1:3101,http://localhost:3101',
};

test('loadConfig normalizes the cloud API environment', () => {
  const config = loadConfig(VALID_ENV);

  assert.deepEqual(config, {
    nodeEnv: 'test',
    port: 3201,
    databaseUrl: VALID_ENV.DATABASE_URL,
    betterAuthSecret: VALID_ENV.BETTER_AUTH_SECRET,
    betterAuthUrl: VALID_ENV.BETTER_AUTH_URL,
    redemptionPepper: VALID_ENV.REDEMPTION_PEPPER,
    registrationMode: 'OPEN',
    passwordResetWebhookUrl: null,
    passwordResetWebhookSecret: null,
    licenseSigningPrivateKey: null,
    licenseSigningKeyId: 'primary',
    adminOrigin: VALID_ENV.ADMIN_ORIGIN,
    trustedOrigins: ['http://127.0.0.1:3101', 'http://localhost:3101'],
  });
});

test('loadConfig rejects missing secrets without echoing their values', () => {
  assert.throws(
    () => loadConfig({ NODE_ENV: 'test', PORT: '3201' }),
    (error) => {
      assert.ok(error instanceof ConfigurationError);
      assert.match(error.message, /DATABASE_URL/);
      assert.match(error.message, /BETTER_AUTH_SECRET/);
      assert.doesNotMatch(error.message, /postgresql:\/\/|test-secret-that-is-at-least-32-characters-long/i);
      return true;
    },
  );
});

test('loadConfig parses the registration mode and rejects invalid values', () => {
  assert.equal(loadConfig({ ...VALID_ENV, REGISTRATION_MODE: 'invite_only' }).registrationMode, 'INVITE_ONLY');
  assert.throws(
    () => loadConfig({ ...VALID_ENV, REGISTRATION_MODE: 'sometimes' }),
    (error) => error instanceof ConfigurationError && /REGISTRATION_MODE/.test(error.message),
  );
});

test('loadConfig rejects weak production auth secrets', () => {
  assert.throws(
    () => loadConfig({
      ...VALID_ENV,
      NODE_ENV: 'production',
      BETTER_AUTH_SECRET: 'short',
      LICENSE_SIGNING_PRIVATE_KEY: 'configured-for-this-validation-case',
      PASSWORD_RESET_WEBHOOK_URL: 'https://mailer.example.com/password-reset',
      PASSWORD_RESET_WEBHOOK_SECRET: 'production-password-reset-secret-that-is-long-enough',
    }),
    /BETTER_AUTH_SECRET.*32/i,
  );
});

test('loadConfig rejects production without the offline grant signing key', () => {
  const productionEnv = {
    ...VALID_ENV,
    NODE_ENV: 'production',
    BETTER_AUTH_SECRET: 'production-auth-secret-that-is-at-least-32-characters-long',
    REDEMPTION_PEPPER: 'production-redemption-pepper-that-is-at-least-32-characters',
    BETTER_AUTH_URL: 'https://api.example.com',
    ADMIN_ORIGIN: 'https://admin.example.com',
    TRUSTED_ORIGINS: 'https://admin.example.com',
  };
  assert.throws(
    () => loadConfig(productionEnv),
    (error) => error instanceof ConfigurationError && /LICENSE_SIGNING_PRIVATE_KEY/.test(error.message),
  );
});

test('loadConfig requires a signed password reset delivery webhook in production', () => {
  const productionEnv = {
    ...VALID_ENV,
    NODE_ENV: 'production',
    BETTER_AUTH_SECRET: 'production-auth-secret-that-is-at-least-32-characters-long',
    REDEMPTION_PEPPER: 'production-redemption-pepper-that-is-at-least-32-characters',
    LICENSE_SIGNING_PRIVATE_KEY: 'configured-for-this-validation-case',
    BETTER_AUTH_URL: 'https://api.example.com',
    ADMIN_ORIGIN: 'https://admin.example.com',
    TRUSTED_ORIGINS: 'https://admin.example.com',
  };
  assert.throws(
    () => loadConfig(productionEnv),
    (error) => error instanceof ConfigurationError && /PASSWORD_RESET_WEBHOOK/.test(error.message),
  );
});

test('loadConfig validates a password reset webhook without exposing its secret', () => {
  const config = loadConfig({
    ...VALID_ENV,
    PASSWORD_RESET_WEBHOOK_URL: 'https://mailer.example.test/password-reset',
    PASSWORD_RESET_WEBHOOK_SECRET: 'test-password-reset-secret',
  });

  assert.equal(config.passwordResetWebhookUrl, 'https://mailer.example.test/password-reset');
  assert.equal(config.passwordResetWebhookSecret, 'test-password-reset-secret');
  const safe = toSafeConfig(config);
  assert.equal('passwordResetWebhookUrl' in safe, false);
  assert.equal('passwordResetWebhookSecret' in safe, false);
  assert.doesNotMatch(JSON.stringify(safe), /test-password-reset-secret/);
});

test('loadConfig rejects a missing redemption pepper', () => {
  const env = { ...VALID_ENV };
  delete env.REDEMPTION_PEPPER;
  assert.throws(
    () => loadConfig(env),
    (error) => error instanceof ConfigurationError && /REDEMPTION_PEPPER/.test(error.message),
  );
});

test('toSafeConfig excludes database and authentication secrets', () => {
  const safe = toSafeConfig(loadConfig(VALID_ENV));

  assert.deepEqual(safe, {
    nodeEnv: 'test',
    port: 3201,
    betterAuthUrl: VALID_ENV.BETTER_AUTH_URL,
    adminOrigin: VALID_ENV.ADMIN_ORIGIN,
    trustedOrigins: ['http://127.0.0.1:3101', 'http://localhost:3101'],
  });
  assert.equal('databaseUrl' in safe, false);
  assert.equal('betterAuthSecret' in safe, false);
});
