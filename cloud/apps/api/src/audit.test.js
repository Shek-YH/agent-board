const test = require('node:test');
const assert = require('node:assert/strict');

const { createAuditService, sanitizeAuditValue } = require('./audit');

test('audit snapshots omit passwords, tokens, cookies, private keys, secrets, and codes', () => {
  const snapshot = sanitizeAuditValue({
    name: 'Alice',
    password: 'do-not-store',
    accessToken: 'do-not-store',
    refreshToken: 'do-not-store',
    cookie: 'do-not-store',
    devicePrivateKey: 'do-not-store',
    databaseSecret: 'do-not-store',
    redemptionCode: 'ABCD-EFGH',
    nested: { status: 'ACTIVE', token: 'do-not-store' },
  });

  assert.deepEqual(snapshot, {
    name: 'Alice',
    nested: { status: 'ACTIVE' },
  });
});

test('audit service persists only sanitized before and after snapshots', async () => {
  let captured;
  const database = {
    auditLog: {
      create: async ({ data }) => {
        captured = data;
        return data;
      },
    },
  };

  await createAuditService(database).record({
    actorType: 'USER',
    actorId: 'admin-1',
    action: 'USER_DISABLED',
    targetType: 'USER',
    targetId: 'user-1',
    before: { status: 'ACTIVE', password: 'hidden' },
    after: { status: 'DISABLED', code: 'hidden' },
    requestId: 'request-1',
    ip: '127.0.0.1',
    userAgent: 'test-agent',
  });

  assert.equal(captured.actorId, 'admin-1');
  assert.deepEqual(captured.beforeSanitized, { status: 'ACTIVE' });
  assert.deepEqual(captured.afterSanitized, { status: 'DISABLED' });
  assert.equal(JSON.stringify(captured).includes('hidden'), false);
});

test('audit service lists records with stable pagination and safe fields', async () => {
  let query;
  const database = {
    auditLog: {
      findMany: async (args) => {
        query = args;
        return [{
          id: 'audit-1',
          actorType: 'USER',
          actorId: 'admin-1',
          action: 'USER_DISABLED',
          targetType: 'USER',
          targetId: 'user-1',
          beforeSanitized: { status: 'ACTIVE' },
          afterSanitized: { status: 'DISABLED' },
          requestId: 'request-1',
          ip: '127.0.0.1',
          userAgent: 'test-agent',
          createdAt: new Date('2026-01-01T00:00:00Z'),
        }];
      },
      count: async () => 11,
    },
  };

  const result = await createAuditService(database).list({ page: '2', pageSize: '5' });

  assert.equal(query.skip, 5);
  assert.equal(query.take, 5);
  assert.equal(query.orderBy.createdAt, 'desc');
  assert.deepEqual(result.meta, { page: 2, pageSize: 5, total: 11 });
  assert.equal(result.items[0].beforeSanitized.status, 'ACTIVE');
  assert.equal('password' in result.items[0], false);
});
