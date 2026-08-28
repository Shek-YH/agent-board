const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { DeviceService, verifyDeviceSignature } = require('./device.service');

const now = new Date('2026-08-28T12:00:00.000Z');

function makeDatabase(maxRegisteredDevices = 1) {
  const devices = new Map();
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
  };
  return { database, devices, auditRecords, audit: { record: async (record) => auditRecords.push(record) } };
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
