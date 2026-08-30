const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { DeviceService, verifyDeviceSignature } = require('./device.service');

const now = new Date('2026-08-28T12:00:00.000Z');

function makeDatabase(maxRegisteredDevices = 1) {
  const devices = new Map();
  const leases = new Map();
  const resetEvents = [];
  const auditRecords = [];
  let nextId = 0;
  const database = {
    $transaction: async (callback) => callback(database),
    user: { findUnique: async () => ({ id: 'user-1', profile: { status: 'ACTIVE' } }) },
    entitlement: {
      findFirst: async () => ({
        id: 'entitlement-1', userId: 'user-1', status: 'ACTIVE', isPermanent: false,
        expiresAt: new Date('2026-09-28T12:00:00.000Z'),
        plan: { maxRegisteredDevices },
      }),
    },
    device: {
      findUnique: async ({ where }) => {
        if (where.id) return devices.get(where.id) || null;
        return [...devices.values()].find((device) => device.userId === where.userId_installationId.userId && device.installationId === where.userId_installationId.installationId) || null;
      },
      findMany: async ({ where }) => [...devices.values()].filter((device) => device.userId === where.userId),
      count: async ({ where }) => [...devices.values()].filter((device) => device.userId === where.userId && where.status.in.includes(device.status)).length,
      create: async ({ data }) => {
        const device = { id: `device-${++nextId}`, createdAt: now, updatedAt: now, ...data };
        devices.set(device.id, device);
        return device;
      },
      update: async ({ where, data }) => {
        const device = { ...devices.get(where.id), ...data, updatedAt: now };
        devices.set(where.id, device);
        return device;
      },
      updateMany: async ({ where, data }) => {
        const device = devices.get(where.id);
        if (!device || (where.userId && device.userId !== where.userId) || !where.status.in.includes(device.status)) return { count: 0 };
        devices.set(device.id, { ...device, ...data, updatedAt: now });
        return { count: 1 };
      },
    },
    licenseLease: {
      findMany: async ({ where }) => [...leases.values()].filter((lease) => {
        if (where.status && lease.status !== where.status) return false;
        if (where.userId && lease.userId !== where.userId) return false;
        if (where.deviceId && lease.deviceId !== where.deviceId) return false;
        if (where.expiresAt?.gt && !(lease.expiresAt > where.expiresAt.gt)) return false;
        return true;
      }),
      updateMany: async ({ where, data }) => {
        const matched = [...leases.values()].filter((lease) => lease.deviceId === where.deviceId && lease.status === where.status);
        for (const lease of matched) leases.set(lease.id, { ...lease, ...data });
        return { count: matched.length };
      },
    },
    deviceResetEvent: {
      count: async ({ where }) => resetEvents.filter((event) => event.userId === where.userId && event.createdAt > where.createdAt.gt).length,
      create: async ({ data }) => { const event = { id: `reset-${resetEvents.length + 1}`, createdAt: now, ...data }; resetEvents.push(event); return event; },
    },
  };
  return { database, devices, leases, resetEvents, auditRecords, audit: { record: async (record) => auditRecords.push(record) } };
}

function keyPair() {
  const pair = crypto.generateKeyPairSync('ed25519');
  return {
    privateKey: pair.privateKey,
    publicKey: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  };
}

test('enrollment is stable for one installation and enforces maxRegisteredDevices', async () => {
  const { database, devices, auditRecords, audit } = makeDatabase(1);
  const keys = keyPair();
  const service = new DeviceService(database, audit, () => now);
  const input = { installationId: 'install-1', publicKey: keys.publicKey, fingerprintHash: 'hash-1', fingerprintSignalsHash: { cpu: 'hash-cpu' }, fingerprintVersion: 'v1', deviceName: 'Office PC', os: 'Windows' };

  const first = await service.enroll('user-1', input, { ip: '127.0.0.1' });
  const second = await service.enroll('user-1', input, { ip: '127.0.0.2' });

  assert.equal(first.id, second.id);
  assert.equal(devices.size, 1);
  assert.equal(second.lastIp, '127.0.0.2');
  assert.equal(auditRecords.length, 1);
  await assert.rejects(
    service.enroll('user-1', { ...input, installationId: 'install-2' }),
    (error) => error?.getResponse?.().code === 'DEVICE_LIMIT_EXCEEDED',
  );
});

test('revoked installation cannot be silently re-enrolled and a different key cannot take it over', async () => {
  const { database, devices, audit } = makeDatabase(2);
  const keys = keyPair();
  const otherKeys = keyPair();
  const service = new DeviceService(database, audit, () => now);
  const input = { installationId: 'install-1', publicKey: keys.publicKey };
  const enrolled = await service.enroll('user-1', input);

  await assert.rejects(
    service.enroll('user-1', { ...input, publicKey: otherKeys.publicKey }),
    (error) => error?.getResponse?.().code === 'DEVICE_KEY_MISMATCH',
  );
  await service.revoke('user-1', enrolled.id);
  assert.equal(devices.get(enrolled.id).status, 'REVOKED');
  await assert.rejects(
    service.enroll('user-1', input),
    (error) => error?.getResponse?.().code === 'DEVICE_REVOKED',
  );
});

test('device signature verification uses the Ed25519 public key and canonical payload', () => {
  const keys = keyPair();
  const payload = { b: 'value', a: 1 };
  const canonical = JSON.stringify({ a: 1, b: 'value' });
  const signature = crypto.sign(null, Buffer.from(canonical), keys.privateKey).toString('base64');

  assert.equal(verifyDeviceSignature(keys.publicKey, payload, signature), true);
  assert.equal(verifyDeviceSignature(keys.publicKey, { ...payload, a: 2 }, signature), false);
});

test('remote device revocation also revokes every active lease for that device', async () => {
  const state = makeDatabase(1);
  const keys = keyPair();
  const service = new DeviceService(state.database, state.audit, () => now);
  const enrolled = await service.enroll('user-1', { installationId: 'install-remote', publicKey: keys.publicKey });
  state.leases.set('lease-1', { id: 'lease-1', deviceId: enrolled.id, status: 'ACTIVE' });
  state.leases.set('lease-2', { id: 'lease-2', deviceId: enrolled.id, status: 'REVOKED' });

  await service.adminRevoke(enrolled.id, { actorType: 'ADMIN', actorId: 'admin-1' });

  assert.equal(state.leases.get('lease-1').status, 'REVOKED');
  assert.equal(state.leases.get('lease-2').status, 'REVOKED');
});

test('admin revocation is server-side and idempotently blocks the device', async () => {
  const { database, devices, audit } = makeDatabase(1);
  const keys = keyPair();
  const service = new DeviceService(database, audit, () => now);
  const enrolled = await service.enroll('user-1', { installationId: 'install-admin', publicKey: keys.publicKey });

  const first = await service.adminRevoke(enrolled.id, { actorType: 'ADMIN', actorId: 'admin-1' });
  const second = await service.adminRevoke(enrolled.id, { actorType: 'ADMIN', actorId: 'admin-1' });

  assert.equal(first.status, 'REVOKED');
  assert.equal(second.status, 'REVOKED');
  assert.equal(devices.get(enrolled.id).status, 'REVOKED');
});

test('online session listing returns only live leases and supports user/device filters', async () => {
  const { database, leases, audit } = makeDatabase(1);
  leases.set('live', {
    id: 'lease-live', userId: 'user-1', entitlementId: 'entitlement-1', deviceId: 'device-1',
    instanceId: 'instance-1', sessionId: 'session-1', status: 'ACTIVE',
    issuedAt: new Date('2026-08-28T11:00:00.000Z'), expiresAt: new Date('2026-08-28T13:00:00.000Z'),
    lastHeartbeatAt: new Date('2026-08-28T11:59:00.000Z'), lastIp: '127.0.0.1',
  });
  leases.set('expired', {
    id: 'lease-expired', userId: 'user-1', entitlementId: 'entitlement-1', deviceId: 'device-1',
    instanceId: 'instance-2', sessionId: 'session-2', status: 'ACTIVE',
    issuedAt: new Date('2026-08-28T09:00:00.000Z'), expiresAt: new Date('2026-08-28T11:00:00.000Z'),
    lastHeartbeatAt: new Date('2026-08-28T10:59:00.000Z'), lastIp: '127.0.0.2',
  });
  leases.set('revoked', { ...leases.get('live'), id: 'lease-revoked', status: 'REVOKED' });

  const service = new DeviceService(database, audit, () => now);
  const result = await service.listOnlineSessions({ userId: 'user-1', deviceId: 'device-1' });

  assert.deepEqual(result.items.map((item) => item.id), ['lease-live']);
  assert.equal(result.items[0].sessionId, 'session-1');
  assert.equal(result.items[0].status, 'ACTIVE');
});

test('user device reset enforces the plan window and admin reset can override it', async () => {
  const state = makeDatabase(2);
  state.database.entitlement.findFirst = async () => ({
    isPermanent: false,
    expiresAt: new Date('2026-09-28T12:00:00.000Z'),
    plan: { maxRegisteredDevices: 2, deviceResetLimit: 1, deviceResetWindowDays: 30 },
  });
  const keys = keyPair();
  const secondKeys = keyPair();
  const service = new DeviceService(state.database, state.audit, () => now);
  const first = await service.enroll('user-1', { installationId: 'install-reset-1', publicKey: keys.publicKey });
  state.leases.set('lease-reset-1', { id: 'lease-reset-1', deviceId: first.id, status: 'ACTIVE' });

  const reset = await service.reset('user-1', first.id, { actorId: 'user-1' });
  assert.equal(reset.status, 'REVOKED');
  assert.equal(state.leases.get('lease-reset-1').status, 'REVOKED');
  assert.equal(state.resetEvents[0].type, 'USER');

  const second = await service.enroll('user-1', { installationId: 'install-reset-2', publicKey: secondKeys.publicKey });
  await assert.rejects(
    service.reset('user-1', second.id, { actorId: 'user-1' }),
    (error) => error?.getResponse?.().code === 'DEVICE_RESET_LIMIT_REACHED',
  );
  const override = await service.adminReset(second.id, { actorId: 'admin-1' });
  assert.equal(override.status, 'REVOKED');
  assert.equal(state.resetEvents.at(-1).type, 'ADMIN_OVERRIDE');
});
