const test = require('node:test');
const assert = require('node:assert/strict');

const { CatalogService } = require('./catalog.service');

test('creating a product normalizes its code and audits the catalog change', async () => {
  let captured;
  const audits = [];
  const database = {
    product: {
      create: async ({ data }) => {
        captured = data;
        return { id: 'product-1', ...data };
      },
    },
  };
  const service = new CatalogService(database, { record: async (record) => audits.push(record) });

  const result = await service.createProduct(
    { code: ' agent-board ', name: ' Agent Board ' },
    { actorId: 'admin-1', requestId: 'request-4' },
  );

  assert.deepEqual(captured, { code: 'AGENT-BOARD', name: 'Agent Board', status: 'ACTIVE' });
  assert.equal(result.id, 'product-1');
  assert.equal(audits[0].action, 'PRODUCT_CREATED');
});

test('creating a plan persists configured duration and policy fields instead of hardcoding durations', async () => {
  let captured;
  const database = {
    product: { findUnique: async () => ({ id: 'product-1', status: 'ACTIVE' }) },
    plan: {
      create: async ({ data }) => {
        captured = data;
        return { id: 'plan-1', ...data };
      },
    },
  };
  const service = new CatalogService(database, { record: async () => {} });

  await service.createPlan(
    {
      productId: 'product-1',
      code: '30_DAYS',
      name: 'Thirty Days',
      durationSeconds: 2_592_000,
      maxRegisteredDevices: 2,
      maxConcurrentDevices: 1,
      maxInstancesPerDevice: 1,
      heartbeatRequired: true,
      heartbeatIntervalSeconds: 60,
      leaseTtlSeconds: 180,
      offlineGraceSeconds: 900,
      deviceResetLimit: 2,
      deviceResetWindowDays: 30,
      concurrencyPolicy: 'REJECT',
      features: { agent_api: true },
      agentCostCredits: 10,
    },
    { actorId: 'admin-1', requestId: 'request-5' },
  );

  assert.equal(captured.durationSeconds, 2_592_000);
  assert.equal(captured.maxRegisteredDevices, 2);
  assert.equal(captured.features.agent_api, true);
  assert.equal(captured.status, 'ACTIVE');
});
