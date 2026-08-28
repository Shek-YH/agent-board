const test = require('node:test');
const assert = require('node:assert/strict');

const { ensureUserProfile } = require('./user-profile');

test('new identity users receive an idempotent default USER profile', async () => {
  let call;
  const database = {
    userProfile: {
      upsert: async (args) => {
        call = args;
        return { userId: args.where.userId, role: 'USER', status: 'ACTIVE' };
      },
    },
  };

  const profile = await ensureUserProfile(database, { id: 'user-1' });

  assert.deepEqual(call, {
    where: { userId: 'user-1' },
    update: {},
    create: { userId: 'user-1', role: 'USER', status: 'ACTIVE' },
    select: { userId: true, role: true, status: true },
  });
  assert.deepEqual(profile, { userId: 'user-1', role: 'USER', status: 'ACTIVE' });
});
