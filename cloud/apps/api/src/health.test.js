const test = require('node:test');
const assert = require('node:assert/strict');

const { createHealthService } = require('./health');

test('live health is available without touching the database', async () => {
  let calls = 0;
  const health = createHealthService({ checkDatabase: async () => { calls += 1; } });

  assert.deepEqual(await health.live(), { status: 'healthy' });
  assert.equal(calls, 0);
});

test('ready health reports database availability', async () => {
  const health = createHealthService({ checkDatabase: async () => {} });

  assert.deepEqual(await health.ready(), {
    status: 'healthy',
    database: 'healthy',
  });
});

test('ready health hides database error details', async () => {
  const health = createHealthService({
    checkDatabase: async () => { throw new Error('postgres password=do-not-leak'); },
  });

  await assert.rejects(
    health.ready(),
    (error) => {
      assert.equal(error.code, 'DATABASE_UNAVAILABLE');
      assert.equal(error.statusCode, 503);
      assert.doesNotMatch(error.message, /postgres|password|leak/i);
      return true;
    },
  );
});
