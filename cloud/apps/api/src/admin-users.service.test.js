const test = require('node:test');
const assert = require('node:assert/strict');

const { AdminUsersService } = require('./admin-users.service');

test('admin user listing applies pagination and case-insensitive search', async () => {
  let query;
  const database = {
    user: {
      findMany: async (args) => {
        query = args;
        return [{
          id: 'user-1',
          name: 'Alice',
          email: 'alice@example.com',
          emailVerified: true,
          createdAt: new Date('2026-01-01T00:00:00Z'),
          updatedAt: new Date('2026-01-02T00:00:00Z'),
          profile: { role: 'USER', status: 'ACTIVE' },
        }];
      },
      count: async () => 21,
    },
  };

  const result = await new AdminUsersService(database, {}).list({
    page: '2',
    pageSize: '10',
    search: 'Alice',
    status: 'ACTIVE',
  });

  assert.equal(query.skip, 10);
  assert.equal(query.take, 10);
  assert.deepEqual(query.where.OR, [
    { name: { contains: 'Alice', mode: 'insensitive' } },
    { email: { contains: 'Alice', mode: 'insensitive' } },
  ]);
  assert.deepEqual(result.meta, { page: 2, pageSize: 10, total: 21 });
  assert.deepEqual(result.items[0], {
    id: 'user-1',
    name: 'Alice',
    email: 'alice@example.com',
    emailVerified: true,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-02T00:00:00Z'),
    profile: { role: 'USER', status: 'ACTIVE' },
  });
});

test('disabling a user updates profile status and writes an audit record', async () => {
  const auditRecords = [];
  const revokedLeases = [];
  const deletedSessions = [];
  const database = {
    user: {
      findUnique: async () => ({
        id: 'user-1',
        name: 'Alice',
        email: 'alice@example.com',
        emailVerified: true,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-02T00:00:00Z'),
        profile: { role: 'USER', status: 'ACTIVE' },
      }),
    },
    userProfile: {
      upsert: async ({ create, update }) => ({
        role: create?.role || 'USER',
        status: update.status,
      }),
    },
    licenseLease: {
      updateMany: async ({ where, data }) => {
        revokedLeases.push({ where, data });
        return { count: 1 };
      },
    },
    session: {
      deleteMany: async ({ where }) => {
        deletedSessions.push(where);
        return { count: 1 };
      },
    },
    $transaction: async (callback) => callback(database),
  };
  const audit = {
    record: async (record) => auditRecords.push(record),
  };

  const result = await new AdminUsersService(database, audit).setStatus(
    'user-1',
    'DISABLED',
    { actorId: 'admin-1', requestId: 'request-1' },
  );

  assert.equal(result.profile.status, 'DISABLED');
  assert.equal(auditRecords.length, 1);
  assert.deepEqual(revokedLeases[0].where, { userId: 'user-1', status: 'ACTIVE' });
  assert.deepEqual(deletedSessions, [{ userId: 'user-1' }]);
  assert.equal(auditRecords[0].action, 'USER_DISABLED');
  assert.deepEqual(auditRecords[0].before, { status: 'ACTIVE', role: 'USER' });
  assert.deepEqual(auditRecords[0].after, { status: 'DISABLED', role: 'USER' });
});

test('creating a user delegates password handling to Better Auth and audits only safe fields', async () => {
  let signUpBody;
  const auditRecords = [];
  const database = {
    userProfile: {
      upsert: async () => ({ role: 'USER', status: 'ACTIVE' }),
    },
    user: {
      findUnique: async () => ({
        id: 'user-2',
        name: 'Bob',
        email: 'bob@example.com',
        emailVerified: false,
        createdAt: new Date('2026-01-03T00:00:00Z'),
        updatedAt: new Date('2026-01-03T00:00:00Z'),
        profile: { role: 'USER', status: 'ACTIVE' },
      }),
    },
  };
  const identity = {
    api: {
      signUpEmail: async ({ body }) => {
        signUpBody = body;
        return { user: { id: 'user-2' }, token: 'must-not-return' };
      },
    },
  };
  const audit = { record: async (record) => auditRecords.push(record) };

  const result = await new AdminUsersService(database, audit, identity).create({
    name: 'Bob',
    email: 'bob@example.com',
    password: 'correct-horse-battery-staple',
  }, { actorId: 'admin-1', requestId: 'request-2' });

  assert.deepEqual(signUpBody, {
    name: 'Bob',
    email: 'bob@example.com',
    password: 'correct-horse-battery-staple',
  });
  assert.equal(result.id, 'user-2');
  assert.equal(auditRecords[0].action, 'USER_CREATED');
  assert.deepEqual(auditRecords[0].after, {
    id: 'user-2',
    name: 'Bob',
    email: 'bob@example.com',
    role: 'USER',
    status: 'ACTIVE',
  });
  assert.equal(JSON.stringify(auditRecords).includes('correct-horse'), false);
});
