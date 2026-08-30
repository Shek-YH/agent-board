const test = require('node:test');
const assert = require('node:assert/strict');

const { buildAuthConfig } = require('./auth-config');

test('buildAuthConfig enables email/password and trusted origins', () => {
  const config = buildAuthConfig({
    betterAuthSecret: 'test-secret-that-is-at-least-32-characters-long',
    betterAuthUrl: 'http://127.0.0.1:3200',
    trustedOrigins: ['http://127.0.0.1:3100'],
    nodeEnv: 'test',
  });

  assert.deepEqual(config, {
    secret: 'test-secret-that-is-at-least-32-characters-long',
    baseURL: 'http://127.0.0.1:3200',
    trustedOrigins: ['http://127.0.0.1:3100'],
    emailAndPassword: { enabled: true },
    advanced: { useSecureCookies: false },
  });
});

test('buildAuthConfig uses secure cookies in production', () => {
  const config = buildAuthConfig({
    betterAuthSecret: 'production-secret-that-is-at-least-32-characters-long',
    betterAuthUrl: 'https://api.example.com',
    trustedOrigins: ['https://admin.example.com'],
    nodeEnv: 'production',
  });

  assert.equal(config.advanced.useSecureCookies, true);
});

test('buildAuthConfig keeps Better Auth identity enabled for managed registration modes', () => {
  const config = buildAuthConfig({
    betterAuthSecret: 'test-secret-that-is-at-least-32-characters-long',
    betterAuthUrl: 'http://127.0.0.1:3200',
    trustedOrigins: ['http://127.0.0.1:3100'],
    nodeEnv: 'test',
    registrationMode: 'INVITE_ONLY',
  });

  assert.deepEqual(config.emailAndPassword, { enabled: true });
});
