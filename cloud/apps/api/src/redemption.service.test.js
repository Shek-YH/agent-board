const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { RedemptionService } = require('./redemption.service');

const now = new Date('2026-08-28T12:00:00.000Z');
const pepper = 'test-redemption-pepper';

function hashCode(code) {
  return crypto.createHmac('sha256', pepper).update(code, 'utf8').digest('hex');
}

test('batch generation stores only an HMAC and returns the plaintext code once', async () => {
  let batchData;
  let codeData;
  const database = {
    product: { findUnique: async () => ({ id: 'product-1', status: 'ACTIVE' }) },
    plan: {
      findUnique: async () => ({
        id: 'plan-1', productId: 'product-1', status: 'ACTIVE', durationSeconds: 2_592_000, isPermanent: false,
      }),
    },
    $transaction: async (callback) => callback(database),
    redemptionBatch: {
      create: async ({ data }) => {
        batchData = data;
        return { id: 'batch-1', ...data };
      },
    },
    redemptionCode: {
      create: async ({ data }) => {
        codeData = data;
        return { id: 'code-1', ...data };
      },
    },
  };
  const service = new RedemptionService(
    database,
    {},
    { record: async () => {} },
    pepper,
    () => now,
    () => Buffer.from('fixed-random-bytes'),
  );

  const result = await service.createBatch(
    { name: 'Test batch', productId: 'product-1', planId: 'plan-1', quantity: 1 },
    { actorId: 'admin-1', requestId: 'request-1' },
  );

  const plaintext = result.codes[0].code;
  assert.equal(codeData.codeHash, hashCode(plaintext));
  assert.equal(codeData.codeLast4, plaintext.slice(-4));
  assert.equal('code' in codeData, false);
  assert.equal(JSON.stringify(codeData).includes(plaintext), false);
  assert.equal(batchData.quantity, 1);
  assert.match(result.csv, new RegExp(`^code,codeLast4,codeExpiresAt\\r?\\n${plaintext},`));
});

function makeRedeemDatabase(code, { onClaim, storedDurationSeconds = 2_592_000, planDurationSeconds = 2_592_000 } = {}) {
  let requestRecord = null;
  let claimCount = 0;
  const database = {
    $transaction: async (callback) => callback(database),
    redemptionRequest: {
      findUnique: async () => requestRecord,
      create: async ({ data }) => {
        requestRecord = { id: 'request-1', ...data };
        return requestRecord;
      },
    },
    user: { findUnique: async () => ({ id: 'user-1', profile: { status: 'ACTIVE' } }) },
    redemptionCode: {
      findUnique: async () => ({
        id: 'code-1', batchId: 'batch-1', codeHash: hashCode(code), codeLast4: code.slice(-4),
        planId: 'plan-1', durationSeconds: storedDurationSeconds, status: 'UNUSED', codeExpiresAt: null,
      }),
      updateMany: async (args) => {
        claimCount += 1;
        if (onClaim) return onClaim(args, claimCount);
        return { count: 1 };
      },
    },
    plan: { findUnique: async () => ({ id: 'plan-1', productId: 'product-1', status: 'ACTIVE', isPermanent: false, durationSeconds: planDurationSeconds }) },
    product: { findUnique: async () => ({ id: 'product-1', status: 'ACTIVE' }) },
  };
  return { database, getRequest: () => requestRecord, getClaimCount: () => claimCount };
}

test('redeem is idempotent for the same requestId', async () => {
  const { database, getClaimCount } = makeRedeemDatabase('TEST-CODE');
  const grantCalls = [];
  const service = new RedemptionService(
    database,
    { grantToUserInTransaction: async (_transaction, userId, input) => {
      grantCalls.push({ userId, input });
      return { entitlement: { id: 'entitlement-1' }, grant: { id: 'grant-1' } };
    } },
    { record: async () => {} },
    pepper,
    () => now,
  );

  const first = await service.redeem('user-1', { code: 'TEST-CODE', requestId: 'request-1' });
  const second = await service.redeem('user-1', { code: 'TEST-CODE', requestId: 'request-1' });

  assert.deepEqual(second, first);
  assert.equal(getClaimCount(), 1);
  assert.equal(grantCalls.length, 1);
});

test('the same idempotency key cannot be reused with a different redemption code', async () => {
  const { database } = makeRedeemDatabase('TEST-CODE');
  const service = new RedemptionService(
    database,
    { grantToUserInTransaction: async () => ({ entitlement: { id: 'entitlement-1' }, grant: { id: 'grant-1' } }) },
    { record: async () => {} },
    pepper,
    () => now,
  );

  await service.redeem('user-1', { code: 'TEST-CODE', requestId: 'request-1' });
  await assert.rejects(
    service.redeem('user-1', { code: 'OTHER-CODE', requestId: 'request-1' }),
    (error) => error?.getResponse?.().code === 'IDEMPOTENCY_KEY_REUSED',
  );
});

test('a concurrent idempotency conflict cannot reuse the key with a different redemption code', async () => {
  let lookupCount = 0;
  const database = {
    redemptionRequest: {
      findUnique: async () => {
        lookupCount += 1;
        return lookupCount === 1 ? null : {
          userId: 'user-1',
          codeHash: hashCode('TEST-CODE'),
          response: { codeId: 'code-1' },
        };
      },
    },
    $transaction: async () => {
      const error = new Error('synthetic unique conflict');
      error.code = 'P2002';
      throw error;
    },
  };
  const service = new RedemptionService(database, {}, {}, pepper, () => now);

  await assert.rejects(
    service.redeem('user-1', { code: 'OTHER-CODE', requestId: 'request-race' }),
    (error) => error?.getResponse?.().code === 'IDEMPOTENCY_KEY_REUSED',
  );
});

test('redeem uses the duration snapshot stored on the code', async () => {
  const { database } = makeRedeemDatabase('SNAPSHOT-CODE', { storedDurationSeconds: 3600, planDurationSeconds: 7200 });
  let grantInput;
  const service = new RedemptionService(
    database,
    { grantToUserInTransaction: async (_transaction, _userId, input) => {
      grantInput = input;
      return { entitlement: { id: 'entitlement-1' }, grant: { id: 'grant-1' } };
    } },
    { record: async () => {} },
    pepper,
    () => now,
  );

  await service.redeem('user-1', { code: 'SNAPSHOT-CODE', requestId: 'request-snapshot' });

  assert.equal(grantInput.durationSeconds, 3600);
});

test('concurrent redemption claims use a single successful CAS update', async () => {
  let claimed = false;
  const { database } = makeRedeemDatabase('RACE-CODE', {
    onClaim: async () => {
      if (claimed) return { count: 0 };
      claimed = true;
      return { count: 1 };
    },
  });
  const service = new RedemptionService(
    database,
    { grantToUserInTransaction: async () => ({ entitlement: { id: 'entitlement-1' }, grant: { id: 'grant-1' } }) },
    { record: async () => {} },
    pepper,
    () => now,
  );

  const results = await Promise.allSettled([
    ...Array.from({ length: 20 }, (_, index) => service.redeem('user-1', {
      code: 'RACE-CODE',
      requestId: `request-${index}`,
    })),
  ]);

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 19);
  assert.equal(results.find((result) => result.status === 'rejected').reason.getResponse().code, 'REDEMPTION_ALREADY_USED');
});

test('revocation cannot overwrite a code that was redeemed after the initial read', async () => {
  let row = { id: 'code-1', status: 'UNUSED', codeLast4: 'CODE' };
  const database = {
    $transaction: async (callback) => callback(database),
    redemptionCode: {
      findUnique: async () => ({ ...row }),
      updateMany: async ({ where }) => {
        assert.equal(where.status, 'UNUSED');
        row = { ...row, status: 'REDEEMED' };
        return { count: 0 };
      },
    },
  };
  const service = new RedemptionService(database, {}, { record: async () => {} }, pepper, () => now);

  await assert.rejects(
    service.revokeCode('code-1', { actorId: 'admin-1', requestId: 'request-revoke-race' }),
    (error) => error?.getResponse?.().code === 'REDEMPTION_ALREADY_USED',
  );
  assert.equal(row.status, 'REDEEMED');
});

test('expiry cannot overwrite a code that was revoked after the initial read', async () => {
  let row = {
    id: 'code-1',
    planId: 'plan-1',
    status: 'UNUSED',
    codeExpiresAt: new Date('2026-08-28T11:59:00.000Z'),
  };
  const database = {
    $transaction: async (callback) => callback(database),
    redemptionRequest: { findUnique: async () => null },
    user: { findUnique: async () => ({ id: 'user-1', profile: { status: 'ACTIVE' } }) },
    redemptionCode: {
      findUnique: async ({ where }) => (where.codeHash ? { ...row } : { ...row }),
      updateMany: async ({ where }) => {
        assert.equal(where.status, 'UNUSED');
        row = { ...row, status: 'REVOKED' };
        return { count: 0 };
      },
    },
  };
  const service = new RedemptionService(database, {}, {}, pepper, () => now);

  await assert.rejects(
    service.redeem('user-1', { code: 'EXPIRED-CODE', requestId: 'request-expiry-race' }),
    (error) => error?.getResponse?.().code === 'REDEMPTION_REVOKED',
  );
  assert.equal(row.status, 'REVOKED');
});

test('batch and code listings can be restricted to an agent data scope', async () => {
  const calls = [];
  const database = {
    redemptionBatch: { findMany: async (args) => { calls.push(args); return []; } },
    redemptionCode: { findMany: async (args) => { calls.push(args); return []; } },
  };
  const service = new RedemptionService(database, {}, {}, pepper, () => now);

  await service.listBatches({ ownerAgentIds: ['agent-a', 'agent-a1'] });
  await service.listCodes({ ownerAgentIds: ['agent-a', 'agent-a1'] });

  assert.deepEqual(calls, [
    { where: { ownerAgentId: { in: ['agent-a', 'agent-a1'] } }, orderBy: { createdAt: 'desc' } },
    { where: { ownerAgentId: { in: ['agent-a', 'agent-a1'] } }, orderBy: { createdAt: 'desc' } },
  ]);
});

test('batch status filters reject unknown values', async () => {
  const database = { redemptionBatch: { findMany: async () => [] } };
  const service = new RedemptionService(database, {}, {}, pepper, () => now);

  await assert.rejects(
    service.listBatches({ status: 'not-a-status' }),
    (error) => error?.getResponse?.().code === 'INVALID_REDEMPTION_STATUS',
  );
});

test('agent batch creation checks plan allowlist and debits the immutable ledger in the same transaction', async () => {
  let ledgerInput;
  let codeCount = 0;
  const database = {
    product: { findUnique: async () => ({ id: 'product-1', status: 'ACTIVE' }) },
    plan: { findUnique: async () => ({ id: 'plan-1', productId: 'product-1', status: 'ACTIVE', isPermanent: false, durationSeconds: 3600, agentCostCredits: 3 }) },
    $transaction: async (callback) => callback(database),
    redemptionBatch: { create: async ({ data }) => ({ id: 'batch-1', ...data }) },
    redemptionCode: { create: async ({ data }) => { codeCount += 1; return { id: `code-${codeCount}`, ...data }; } },
  };
  const agents = {
    isPlanAllowed: async (_agentId, planId) => planId === 'plan-1',
    adjustLedgerInTransaction: async (_transaction, agentId, input, context) => { ledgerInput = { agentId, input, context }; return { balance: 4 }; },
  };
  const service = new RedemptionService(database, {}, { record: async () => {} }, pepper, () => now, () => Buffer.from('fixed-random-bytes'), agents);

  await service.createBatch({ name: 'Agent batch', productId: 'product-1', planId: 'plan-1', quantity: 2, ownerAgentId: 'agent-1' }, { actorId: 'agent-user-1', actorType: 'AGENT' });

  assert.equal(ledgerInput.agentId, 'agent-1');
  assert.equal(ledgerInput.input.type, 'DEBIT');
  assert.equal(ledgerInput.input.amount, 6);
  assert.equal(ledgerInput.input.relatedBatchId, 'batch-1');
  assert.equal(ledgerInput.context.actorId, 'agent-user-1');
  assert.equal(codeCount, 2);
});
