'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const { LeaseService, canonicalizePayload } = require('./lease.service');
const { createOfflineGrantService } = require('./offline-grant.service');

const now = new Date('2026-08-28T12:00:00.000Z');

function keyPair() {
  const pair = crypto.generateKeyPairSync('ed25519');
  return {
    privateKey: pair.privateKey,
    publicKey: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  };
}

function sign(privateKey, payload) {
  return crypto.sign(null, Buffer.from(JSON.stringify(canonicalizePayload(payload))), privateKey).toString('base64');
}

function request(privateKey, payload) {
  return { ...payload, signature: sign(privateKey, payload) };
}

function makeDatabase({ maxConcurrentDevices = 1, maxInstancesPerDevice = 1, concurrencyPolicy = 'REJECT', entitlementExpiresAt = new Date('2026-09-28T12:00:00.000Z') } = {}) {
  const devices = new Map();
  const leases = new Map();
  const auditRecords = [];
  let nextLeaseId = 0;
  const plan = {
    id: 'plan-1', productId: 'product-1', status: 'ACTIVE', isPermanent: false,
    maxConcurrentDevices, maxInstancesPerDevice, heartbeatRequired: true,
    heartbeatIntervalSeconds: 60, leaseTtlSeconds: 180, offlineGraceSeconds: 0,
    concurrencyPolicy, features: { claude: true },
  };
  const user = { id: 'user-1', profile: { status: 'ACTIVE' } };
  const entitlement = {
    id: 'entitlement-1', userId: 'user-1', productId: 'product-1', planId: plan.id,
    status: 'ACTIVE', isPermanent: false, expiresAt: entitlementExpiresAt,
    plan,
  };

  const matches = (record, where = {}) => {
    if (where.id && record.id !== where.id) return false;
    if (where.userId && record.userId !== where.userId) return false;
    if (where.deviceId && record.deviceId !== where.deviceId) return false;
    if (where.status && record.status !== where.status) return false;
    if (where.sessionId && record.sessionId !== where.sessionId) return false;
    if (where.instanceId && record.instanceId !== where.instanceId) return false;
    if (where.sequence?.lt !== undefined && !(record.sequence < where.sequence.lt)) return false;
    if (where.sequence?.gt !== undefined && !(record.sequence > where.sequence.gt)) return false;
    if (where.expiresAt?.gt !== undefined && !(record.expiresAt > where.expiresAt.gt)) return false;
    if (where.expiresAt?.lte !== undefined && !(record.expiresAt <= where.expiresAt.lte)) return false;
    return true;
  };

  const database = {
    $transaction: async (callback) => callback(database),
    user: { findUnique: async () => user },
    entitlement: {
      findFirst: async () => entitlement,
    },
    device: {
      findUnique: async ({ where }) => devices.get(where.id) || null,
      update: async ({ where, data }) => {
        const device = { ...devices.get(where.id), ...data, updatedAt: now };
        devices.set(where.id, device);
        return device;
      },
    },
    licenseLease: {
      findUnique: async ({ where }) => leases.get(where.id) || null,
      findFirst: async ({ where, orderBy }) => {
        const values = [...leases.values()].filter((lease) => matches(lease, where));
        values.sort((left, right) => (orderBy?.createdAt === 'asc' ? left.createdAt - right.createdAt : right.createdAt - left.createdAt));
        return values[0] || null;
      },
      findMany: async ({ where }) => [...leases.values()].filter((lease) => matches(lease, where)),
      create: async ({ data }) => {
        const lease = { id: `lease-${++nextLeaseId}`, createdAt: now, ...data };
        leases.set(lease.id, lease);
        return lease;
      },
      update: async ({ where, data }) => {
        const lease = { ...leases.get(where.id), ...data };
        leases.set(where.id, lease);
        return lease;
      },
      updateMany: async ({ where, data }) => {
        const matched = [...leases.values()].filter((lease) => matches(lease, where));
        for (const lease of matched) leases.set(lease.id, { ...lease, ...data });
        return { count: matched.length };
      },
    },
  };

  return {
    database,
    devices,
    leases,
    auditRecords,
    audit: { record: async (record) => auditRecords.push(record) },
    plan,
    entitlement,
    user,
  };
}

function addDevice(databaseState, id, keys) {
  databaseState.devices.set(id, {
    id,
    userId: 'user-1',
    publicKey: keys.publicKey,
    status: 'ACTIVE',
    lastSeenAt: now,
  });
}

function baseRequest(deviceId, instanceId, sessionId, timestamp = now.toISOString()) {
  return { deviceId, instanceId, sessionId, timestamp, nonce: `nonce-${deviceId}-${instanceId}`, appVersion: '1.0.0' };
}

test('acquire validates the device signature and creates a plan-backed lease', async () => {
  const state = makeDatabase({ maxConcurrentDevices: 2 });
  const keys = keyPair();
  addDevice(state, 'device-1', keys);
  const service = new LeaseService(state.database, state.audit, () => now);
  const input = request(keys.privateKey, baseRequest('device-1', 'instance-1', 'session-1'));

  const result = await service.acquire('user-1', input, { ip: '127.0.0.1' });

  assert.equal(result.lease.status, 'ACTIVE');
  assert.equal(result.lease.sequence, 0);
  assert.equal(result.lease.deviceId, 'device-1');
  assert.equal(result.limits.maxConcurrentDevices, 2);
  assert.deepEqual(result.features, { claude: true });
  assert.equal(state.auditRecords.length, 1);
  await assert.rejects(
    service.acquire('user-1', { ...input, signature: 'invalid' }),
    (error) => error?.getResponse?.().code === 'INVALID_DEVICE_SIGNATURE',
  );
});

test('KICK_OLDEST revokes the oldest device lease before creating a new one', async () => {
  const state = makeDatabase({ maxConcurrentDevices: 1, concurrencyPolicy: 'KICK_OLDEST' });
  const firstKeys = keyPair();
  const secondKeys = keyPair();
  addDevice(state, 'device-1', firstKeys);
  addDevice(state, 'device-2', secondKeys);
  const service = new LeaseService(state.database, state.audit, () => now);
  const first = await service.acquire('user-1', request(firstKeys.privateKey, baseRequest('device-1', 'instance-1', 'session-1')));
  const second = await service.acquire('user-1', request(secondKeys.privateKey, baseRequest('device-2', 'instance-2', 'session-2')));

  assert.equal(state.leases.get(first.lease.id).status, 'REVOKED');
  assert.equal(second.lease.status, 'ACTIVE');
  assert.equal(state.auditRecords.some((record) => record.action === 'LEASE_KICKED_OLDEST'), true);
  await assert.rejects(
    service.heartbeat('user-1', request(firstKeys.privateKey, { ...baseRequest('device-1', 'instance-1', 'session-1'), leaseId: first.lease.id, sequence: 1 })),
    (error) => error?.getResponse?.().code === 'LEASE_REVOKED',
  );
});

test('ASK_USER reports a concurrency decision instead of silently selecting a lease', async () => {
  const state = makeDatabase({ maxConcurrentDevices: 1, concurrencyPolicy: 'ASK_USER' });
  const firstKeys = keyPair();
  const secondKeys = keyPair();
  addDevice(state, 'device-1', firstKeys);
  addDevice(state, 'device-2', secondKeys);
  const service = new LeaseService(state.database, state.audit, () => now);

  await service.acquire('user-1', request(firstKeys.privateKey, baseRequest('device-1', 'instance-1', 'session-1')));
  await assert.rejects(
    service.acquire('user-1', request(secondKeys.privateKey, baseRequest('device-2', 'instance-2', 'session-2'))),
    (error) => error?.getResponse?.().code === 'CONCURRENT_DEVICE_LIMIT' && error?.getResponse?.().details?.policy === 'ASK_USER',
  );
});

test('heartbeat atomically advances sequence, renews TTL, and rejects replay without audit amplification', async () => {
  const state = makeDatabase();
  const keys = keyPair();
  addDevice(state, 'device-1', keys);
  let currentTime = now;
  const service = new LeaseService(state.database, state.audit, () => currentTime);
  const acquired = await service.acquire('user-1', request(keys.privateKey, baseRequest('device-1', 'instance-1', 'session-1')));
  currentTime = new Date(now.getTime() + 30_000);
  const heartbeatPayload = { ...baseRequest('device-1', 'instance-1', 'session-1', currentTime.toISOString()), leaseId: acquired.lease.id, sequence: 1 };
  const renewed = await service.heartbeat('user-1', request(keys.privateKey, heartbeatPayload), { ip: '127.0.0.2' });

  assert.equal(renewed.lease.sequence, 1);
  assert.equal(renewed.lease.lastIp, '127.0.0.2');
  assert.ok(new Date(renewed.lease.expiresAt) > new Date(acquired.lease.expiresAt));
  assert.equal(state.auditRecords.length, 1);
  await assert.rejects(
    service.heartbeat('user-1', request(keys.privateKey, heartbeatPayload)),
    (error) => error?.getResponse?.().code === 'HEARTBEAT_REPLAY',
  );
  assert.equal(state.auditRecords.length, 1);
});

test('disabled users and expired entitlements cannot acquire or renew a lease', async () => {
  const state = makeDatabase({ entitlementExpiresAt: new Date('2026-08-27T12:00:00.000Z') });
  const keys = keyPair();
  addDevice(state, 'device-1', keys);
  const service = new LeaseService(state.database, state.audit, () => now);
  const input = request(keys.privateKey, baseRequest('device-1', 'instance-1', 'session-1'));

  await assert.rejects(service.acquire('user-1', input), (error) => error?.getResponse?.().code === 'ENTITLEMENT_EXPIRED');
  state.entitlement.expiresAt = new Date('2026-09-28T12:00:00.000Z');
  const acquired = await service.acquire('user-1', input);
  state.user.profile.status = 'SUSPENDED';
  await assert.rejects(service.acquire('user-1', input), (error) => error?.getResponse?.().code === 'USER_SUSPENDED');
  state.user.profile.status = 'DISABLED';
  const heartbeat = request(keys.privateKey, { ...baseRequest('device-1', 'instance-1', 'session-1'), leaseId: acquired.lease.id, sequence: 1 });
  await assert.rejects(service.heartbeat('user-1', heartbeat), (error) => error?.getResponse?.().code === 'USER_DISABLED');
});

test('missing client timestamp returns a stable validation code', async () => {
  const state = makeDatabase();
  const keys = keyPair();
  addDevice(state, 'device-1', keys);
  const service = new LeaseService(state.database, state.audit, () => now);

  await assert.rejects(
    service.acquire('user-1', { deviceId: 'device-1', instanceId: 'instance-1', sessionId: 'session-1', nonce: 'nonce-1', signature: 'not-used' }),
    (error) => error?.getResponse?.().code === 'INVALID_HEARTBEAT_TIMESTAMP',
  );
});

test('minimum client version blocks acquire while supported versions receive policy and signed offline grant', async () => {
  const state = makeDatabase();
  const keys = keyPair();
  addDevice(state, 'device-1', keys);
  state.plan.offlineGraceSeconds = 60;
  const signingKeys = crypto.generateKeyPairSync('ed25519');
  const service = new LeaseService(state.database, state.audit, () => now, {
    versionPolicies: { getActive: async () => ({ id: 'policy-1', productId: 'product-1', latestVersion: '2.0.0', minimumVersion: '1.5.0', forceUpgradeBelow: null, status: 'ACTIVE' }) },
    offlineGrants: createOfflineGrantService({ privateKey: signingKeys.privateKey, keyId: 'license-key-1' }),
  });
  const tooOld = request(keys.privateKey, { ...baseRequest('device-1', 'instance-1', 'session-1'), appVersion: '1.4.9' });
  await assert.rejects(service.acquire('user-1', tooOld), (error) => error?.getResponse?.().code === 'CLIENT_UPDATE_REQUIRED');

  const supportedPayload = { ...baseRequest('device-1', 'instance-1', 'session-1'), appVersion: '1.5.0' };
  const result = await service.acquire('user-1', request(keys.privateKey, supportedPayload));
  assert.equal(result.clientVersionPolicy.status, 'UPDATE_AVAILABLE');
  assert.equal(typeof result.offlineGrant, 'string');
});
