'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  ClientVersionPolicyService,
  compareVersions,
  evaluateClientVersion,
} = require('./version-policy.service');

test('version comparison handles numeric releases and rejects malformed versions', () => {
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(compareVersions('v2.0', '2.0.0'), 0);
  assert.equal(compareVersions('1.2.3', '1.2.4'), -1);
  assert.throws(() => compareVersions('latest', '1.0.0'), (error) => error?.getResponse?.().code === 'INVALID_CLIENT_VERSION');
});

test('client version policy returns supported, update available, and update required states', () => {
  const policy = {
    id: 'policy-1', productId: 'product-1', latestVersion: '2.0.0', minimumVersion: '1.5.0',
    forceUpgradeBelow: '1.6.0', downloadUrl: 'https://example.com/download', message: '请升级', status: 'ACTIVE',
  };

  assert.equal(evaluateClientVersion('2.0.0', policy).status, 'SUPPORTED');
  assert.equal(evaluateClientVersion('1.8.0', policy).status, 'UPDATE_AVAILABLE');
  assert.equal(evaluateClientVersion('1.5.5', policy).status, 'UPDATE_REQUIRED');
  assert.equal(evaluateClientVersion('1.4.9', policy).status, 'UPDATE_REQUIRED');
  assert.equal(evaluateClientVersion('2.0.0', null).status, 'SUPPORTED');
});

test('admin policy service persists a single active policy per product', async () => {
  const policies = new Map();
  const database = {
    product: { findUnique: async () => ({ id: 'product-1', status: 'ACTIVE' }) },
    clientVersionPolicy: {
      findUnique: async ({ where }) => where.id ? [...policies.values()].find((policy) => policy.id === where.id) || null : policies.get(where.productId) || null,
      findMany: async () => [...policies.values()],
      create: async ({ data }) => {
        const policy = { id: 'policy-1', createdAt: new Date(), updatedAt: new Date(), ...data };
        policies.set(policy.productId, policy);
        return policy;
      },
      update: async ({ where, data }) => {
        const policy = { ...policies.get(where.id), ...data, updatedAt: new Date() };
        policies.set(policy.productId, policy);
        return policy;
      },
    },
  };
  const service = new ClientVersionPolicyService(database, { record: async () => {} });
  const created = await service.create({ productId: 'product-1', latestVersion: '2.0.0', minimumVersion: '1.0.0' }, { actorId: 'admin-1' });
  const updated = await service.update(created.id, { minimumVersion: '1.2.0', forceUpgradeBelow: '1.3.0' }, { actorId: 'admin-1' });

  assert.equal(updated.minimumVersion, '1.2.0');
  assert.equal(updated.forceUpgradeBelow, '1.3.0');
  assert.equal((await service.list()).items.length, 1);
});
