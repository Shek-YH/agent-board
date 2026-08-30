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

test('loadConfig rejects weak production auth secrets', () => {
  assert.throws(
    () => loadConfig({ ...VALID_ENV, NODE_ENV: 'production', BETTER_AUTH_SECRET: 'short' }),
    /BETTER_AUTH_SECRET.*32/i,
  );
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
