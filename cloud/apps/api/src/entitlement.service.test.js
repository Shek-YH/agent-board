const test = require('node:test');
const assert = require('node:assert/strict');

const { EntitlementService } = require('./entitlement.service');

const DAY = 24 * 60 * 60;
const now = new Date('2026-08-28T12:00:00.000Z');

function makeDatabase(existingEntitlement, userStatus = 'ACTIVE') {
  const writes = { entitlement: null, grant: null, revokedLeases: null };
  const database = {
    user: {
      findUnique: async () => ({ id: 'user-1', profile: { status: userStatus } }),
    },
    product: {
      findUnique: async () => ({ id: 'product-1', status: 'ACTIVE' }),
    },
    plan: {
      findUnique: async () => ({
        id: 'plan-30',
        productId: 'product-1',
        status: 'ACTIVE',
        durationSeconds: 30 * DAY,
        isPermanent: false,
        features: { agent_api: true },
      }),
    },
    $transaction: async (callback) => callback(database),
    entitlement: {
      findUnique: async () => writes.entitlement || existingEntitlement,
      create: async ({ data }) => {
        writes.entitlement = { ...data, id: 'entitlement-1' };
        return writes.entitlement;
      },
      update: async ({ data }) => {
        writes.entitlement = { ...existingEntitlement, ...data };
        return writes.entitlement;
      },
    },
    entitlementGrant: {
      create: async ({ data }) => {
        writes.grant = { ...data, id: 'grant-1' };
        return writes.grant;
      },
    },
    licenseLease: {
      updateMany: async (args) => { writes.revokedLeases = args; return { count: 1 }; },
    },
  };
  return { database, writes };
}

test('grant extends an active entitlement from its existing expiry and records the grant', async () => {
  const existingExpiresAt = new Date('2026-09-01T12:00:00.000Z');
  const { database, writes } = makeDatabase({
    id: 'entitlement-1',
    userId: 'user-1',
    productId: 'product-1',
    planId: 'plan-30',
    status: 'ACTIVE',
    startsAt: new Date('2026-08-01T12:00:00.000Z'),
    expiresAt: existingExpiresAt,
    isPermanent: false,
  });
  const auditRecords = [];
  const service = new EntitlementService(
    database,
    { record: async (record) => auditRecords.push(record) },
    () => now,
  );

  const result = await service.grantToUser(
    'user-1',
    { productId: 'product-1', planId: 'plan-30' },
    { actorId: 'agent-user-1', agentId: 'agent-1', requestId: 'request-1', source: 'AGENT_GRANT' },
  );

  const expectedExpiry = new Date(existingExpiresAt.getTime() + 30 * DAY * 1000);
  assert.equal(writes.entitlement.expiresAt.getTime(), expectedExpiry.getTime());
  assert.equal(writes.grant.oldExpiresAt.getTime(), existingExpiresAt.getTime());
  assert.equal(writes.grant.newExpiresAt.getTime(), expectedExpiry.getTime());
  assert.equal(writes.grant.source, 'AGENT_GRANT');
  assert.equal(writes.grant.agentId, 'agent-1');
  assert.equal(writes.grant.durationSeconds, 30 * DAY);
  assert.equal(result.entitlement.expiresAt.getTime(), expectedExpiry.getTime());
  assert.equal(auditRecords[0].action, 'ENTITLEMENT_GRANTED');
});

test('grant calculates an expired entitlement from server time instead of the expired timestamp', async () => {
  const expiredAt = new Date('2026-08-01T12:00:00.000Z');
  const { database, writes } = makeDatabase({
    id: 'entitlement-1',
    userId: 'user-1',
    productId: 'product-1',
    planId: 'plan-30',
    status: 'EXPIRED',
    startsAt: new Date('2026-07-01T12:00:00.000Z'),
    expiresAt: expiredAt,
    isPermanent: false,
  });
  const service = new EntitlementService(database, { record: async () => {} }, () => now);

  await service.grantToUser(
    'user-1',
    { productId: 'product-1', planId: 'plan-30' },
    { actorId: 'admin-1', requestId: 'request-2' },
  );

  const expectedExpiry = new Date(now.getTime() + 30 * DAY * 1000);
  assert.equal(writes.entitlement.expiresAt.getTime(), expectedExpiry.getTime());
  assert.equal(writes.grant.oldExpiresAt.getTime(), expiredAt.getTime());
});

test('grant rejects a normal duration when the existing entitlement is permanent', async () => {
  const { database } = makeDatabase({
    id: 'entitlement-1',
    userId: 'user-1',
    productId: 'product-1',
    planId: null,
    status: 'ACTIVE',
    startsAt: new Date('2026-01-01T00:00:00.000Z'),
    expiresAt: null,
    isPermanent: true,
  });
  const service = new EntitlementService(database, { record: async () => {} }, () => now);

  await assert.rejects(
    service.grantToUser(
      'user-1',
      { productId: 'product-1', planId: 'plan-30' },
      { actorId: 'admin-1', requestId: 'request-3' },
    ),
    (error) => error?.getResponse?.().code === 'PERMANENT_ENTITLEMENT',
  );
});

test('grant rejects a suspended user', async () => {
  const { database } = makeDatabase(null, 'SUSPENDED');
  const service = new EntitlementService(database, { record: async () => {} }, () => now);

  await assert.rejects(
    service.grantToUser('user-1', { productId: 'product-1', planId: 'plan-30' }),
    (error) => error?.getResponse?.().code === 'USER_SUSPENDED',
  );
});

test('suspending and revoking an entitlement revoke active leases and audit the transition', async () => {
  const existing = {
    id: 'entitlement-1', userId: 'user-1', productId: 'product-1', planId: 'plan-30',
    status: 'ACTIVE', startsAt: new Date('2026-08-01T00:00:00Z'), expiresAt: new Date('2026-09-01T00:00:00Z'),
    isPermanent: false, suspendedAt: null, revokedAt: null,
  };
  const state = makeDatabase(existing);
  const auditRecords = [];
  const service = new EntitlementService(state.database, { record: async (record) => auditRecords.push(record) }, () => now);

  const suspended = await service.setStatus('entitlement-1', 'SUSPENDED', { actorId: 'admin-1' });
  assert.equal(suspended.status, 'SUSPENDED');
  assert.equal(state.writes.revokedLeases.where.entitlementId, 'entitlement-1');
  assert.equal(auditRecords[0].action, 'ENTITLEMENT_SUSPENDED');
  const resumed = await service.setStatus('entitlement-1', 'ACTIVE', { actorId: 'admin-1' });
  assert.equal(resumed.status, 'ACTIVE');
  const revoked = await service.setStatus('entitlement-1', 'REVOKED', { actorId: 'admin-1' });
  assert.equal(revoked.status, 'REVOKED');
  assert.equal(auditRecords.at(-1).action, 'ENTITLEMENT_REVOKED');
  await assert.rejects(
    service.setStatus('entitlement-1', 'ACTIVE', { actorId: 'admin-1' }),
    (error) => error?.getResponse?.().code === 'ENTITLEMENT_REVOKED',
  );
});

test('entitlement listings can include ordered grant history for admin detail views', async () => {
  let query;
  const database = {
    entitlement: {
      findMany: async (args) => { query = args; return [{ id: 'entitlement-1', grants: [{ id: 'grant-1' }] }]; },
      count: async () => 1,
    },
  };
  const service = new EntitlementService(database, {});

  const result = await service.list({ userId: 'user-1', includeHistory: 'true' });

  assert.deepEqual(query.include, { grants: { orderBy: { createdAt: 'desc' } } });
  assert.equal(result.items[0].grants[0].id, 'grant-1');
});
