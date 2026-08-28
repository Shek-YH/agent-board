'use strict';

const crypto = require('node:crypto');
const { BadRequestException, NotFoundException } = require('@nestjs/common');

const DEVICE_STATUSES = new Set(['PENDING', 'ACTIVE', 'STALE', 'REVOKED', 'BLOCKED']);
const REGISTERED_DEVICE_STATUSES = ['PENDING', 'ACTIVE', 'STALE', 'BLOCKED'];

function bad(code) {
  throw new BadRequestException({ code });
}

function assertId(value, code) {
  if (typeof value !== 'string' || !value.trim()) bad(code);
  return value.trim();
}

function optionalText(value, code, maximum = 255) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.trim().length > maximum) bad(code);
  return value.trim();
}

function parseServerTime(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('Invalid server time');
  return date;
}

function normalizePublicKey(value) {
  if (typeof value !== 'string' || !value.trim()) bad('INVALID_DEVICE_PUBLIC_KEY');
  try {
    const input = value.trim();
    const key = input.includes('BEGIN PUBLIC KEY')
      ? crypto.createPublicKey(input)
      : crypto.createPublicKey({ key: Buffer.from(input, 'base64'), format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ed25519') bad('INVALID_DEVICE_PUBLIC_KEY');
    return key.export({ format: 'der', type: 'spki' }).toString('base64');
  } catch {
    bad('INVALID_DEVICE_PUBLIC_KEY');
  }
}

function normalizeFingerprintSignals(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'object' || Array.isArray(value)) bad('INVALID_FINGERPRINT_SIGNALS');
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    bad('INVALID_FINGERPRINT_SIGNALS');
  }
  if (serialized.length > 8192) bad('INVALID_FINGERPRINT_SIGNALS');
  return JSON.parse(serialized);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  return value;
}

function verifyDeviceSignature(publicKey, payload, signature) {
  if (typeof signature !== 'string' || !signature.trim()) return false;
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(normalizePublicKey(publicKey), 'base64'), format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.from(JSON.stringify(canonicalize(payload)), 'utf8'), key, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}

function serializeDevice(device) {
  if (!device) return null;
  return {
    id: device.id,
    userId: device.userId,
    installationId: device.installationId,
    publicKey: device.publicKey,
    fingerprintHash: device.fingerprintHash,
    fingerprintSignalsHash: device.fingerprintSignalsHash,
    fingerprintVersion: device.fingerprintVersion,
    deviceName: device.deviceName,
    os: device.os,
    osVersion: device.osVersion,
    appVersion: device.appVersion,
    firstSeenAt: device.firstSeenAt,
    lastSeenAt: device.lastSeenAt,
    lastIp: device.lastIp,
    status: device.status,
    trustedAt: device.trustedAt,
    revokedAt: device.revokedAt,
    createdAt: device.createdAt,
    updatedAt: device.updatedAt,
  };
}

class DeviceService {
  constructor(database, audit, clock = () => new Date()) {
    this.database = database;
    this.audit = audit;
    this.clock = clock;
  }

  async enroll(userId, input = {}, context = {}) {
    const id = assertId(userId, 'INVALID_USER_ID');
    const installationId = assertId(input.installationId, 'INVALID_INSTALLATION_ID');
    if (installationId.length > 255) bad('INVALID_INSTALLATION_ID');
    const publicKey = normalizePublicKey(input.publicKey);
    const fingerprintHash = optionalText(input.fingerprintHash, 'INVALID_FINGERPRINT_HASH', 255);
    const fingerprintSignalsHash = normalizeFingerprintSignals(input.fingerprintSignalsHash);
    const fingerprintVersion = optionalText(input.fingerprintVersion, 'INVALID_FINGERPRINT_VERSION', 64);
    const deviceName = optionalText(input.deviceName, 'INVALID_DEVICE_NAME', 120);
    const os = optionalText(input.os, 'INVALID_DEVICE_OS', 64);
    const osVersion = optionalText(input.osVersion, 'INVALID_DEVICE_OS_VERSION', 64);
    const appVersion = optionalText(input.appVersion, 'INVALID_DEVICE_APP_VERSION', 64);
    const productId = input.productId ? assertId(input.productId, 'INVALID_PRODUCT_ID') : null;
    const now = parseServerTime(this.clock());

    return this.database.$transaction(async (transaction) => {
      const user = await transaction.user.findUnique({ where: { id }, select: { id: true, profile: { select: { status: true } } } });
      if (!user) throw new NotFoundException({ code: 'USER_NOT_FOUND' });
      if (user.profile?.status === 'DISABLED') bad('USER_DISABLED');

      const existing = await transaction.device.findUnique({ where: { userId_installationId: { userId: id, installationId } } });
      if (existing) {
        if (existing.status === 'REVOKED') bad('DEVICE_REVOKED');
        if (existing.status === 'BLOCKED') bad('DEVICE_BLOCKED');
        const existingKey = Buffer.from(existing.publicKey);
        const nextKey = Buffer.from(publicKey);
        if (existingKey.length !== nextKey.length || !crypto.timingSafeEqual(existingKey, nextKey)) bad('DEVICE_KEY_MISMATCH');
        const refreshed = await transaction.device.update({
          where: { id: existing.id },
          data: { publicKey, fingerprintHash, fingerprintSignalsHash, fingerprintVersion, deviceName, os, osVersion, appVersion, lastSeenAt: now, lastIp: context.ip || null, status: 'ACTIVE' },
        });
        return serializeDevice(refreshed);
      }

      const entitlementWhere = { userId: id, status: 'ACTIVE', ...(productId ? { productId } : {}) };
      const entitlement = await transaction.entitlement.findFirst({
        where: entitlementWhere,
        orderBy: { updatedAt: 'desc' },
        include: { plan: true },
      });
      if (!entitlement) throw new NotFoundException({ code: 'ENTITLEMENT_REQUIRED' });
      if (!entitlement.isPermanent && (!entitlement.expiresAt || parseServerTime(entitlement.expiresAt) <= now)) bad('ENTITLEMENT_EXPIRED');
      const maxRegisteredDevices = entitlement.plan?.maxRegisteredDevices || 1;
      const registeredCount = await transaction.device.count({ where: { userId: id, status: { in: REGISTERED_DEVICE_STATUSES } } });
      if (registeredCount >= maxRegisteredDevices) bad('DEVICE_LIMIT_EXCEEDED');

      const device = await transaction.device.create({
        data: {
          userId: id,
          installationId,
          publicKey,
          fingerprintHash,
          fingerprintSignalsHash,
          fingerprintVersion,
          deviceName,
          os,
          osVersion,
          appVersion,
          firstSeenAt: now,
          lastSeenAt: now,
          lastIp: context.ip || null,
          status: 'ACTIVE',
        },
      });
      await this.audit?.record?.({
        ...context,
        actorType: 'USER',
        actorId: id,
        action: 'DEVICE_ENROLLED',
        targetType: 'DEVICE',
        targetId: device.id,
        before: null,
        after: { id: device.id, userId: id, installationId, fingerprintVersion, status: device.status },
      }, transaction);
      return serializeDevice(device);
    });
  }

  async listMine(userId) {
    const id = assertId(userId, 'INVALID_USER_ID');
    const devices = await this.database.device.findMany({ where: { userId: id }, orderBy: { createdAt: 'desc' } });
    return { items: devices.map(serializeDevice) };
  }

  async listAll(query = {}) {
    const where = {};
    if (query.userId) where.userId = assertId(query.userId, 'INVALID_USER_ID');
    if (query.status) {
      const status = String(query.status).toUpperCase();
      if (!DEVICE_STATUSES.has(status)) bad('INVALID_DEVICE_STATUS');
      where.status = status;
    }
    const devices = await this.database.device.findMany({ where, orderBy: { lastSeenAt: 'desc' } });
    return { items: devices.map(serializeDevice) };
  }

  async revoke(userId, deviceId, context = {}) {
    const user = assertId(userId, 'INVALID_USER_ID');
    const id = assertId(deviceId, 'INVALID_DEVICE_ID');
    return this.database.$transaction(async (transaction) => {
      const before = await transaction.device.findUnique({ where: { id } });
      if (!before || before.userId !== user) throw new NotFoundException({ code: 'DEVICE_NOT_FOUND' });
      if (before.status === 'REVOKED') return serializeDevice(before);
      const revokedAt = parseServerTime(this.clock());
      const result = await transaction.device.updateMany({
        where: { id, userId: user, status: { in: REGISTERED_DEVICE_STATUSES } },
        data: { status: 'REVOKED', revokedAt },
      });
      if (result.count !== 1) {
        const current = await transaction.device.findUnique({ where: { id } });
        if (current?.status === 'REVOKED') return serializeDevice(current);
        if (current?.status === 'BLOCKED') bad('DEVICE_BLOCKED');
        bad('DEVICE_NOT_AVAILABLE');
      }
      await transaction.licenseLease?.updateMany?.({
        where: { deviceId: id, status: 'ACTIVE' },
        data: { status: 'REVOKED', revokedAt },
      });
      await this.audit?.record?.({
        ...context,
        actorType: 'USER',
        actorId: user,
        action: 'DEVICE_REVOKED',
        targetType: 'DEVICE',
        targetId: id,
        before: { status: before.status },
        after: { status: 'REVOKED' },
      }, transaction);
      return serializeDevice({ ...before, status: 'REVOKED', revokedAt });
    });
  }

  async adminRevoke(deviceId, context = {}) {
    const id = assertId(deviceId, 'INVALID_DEVICE_ID');
    return this.database.$transaction(async (transaction) => {
      const before = await transaction.device.findUnique({ where: { id } });
      if (!before) throw new NotFoundException({ code: 'DEVICE_NOT_FOUND' });
      if (before.status === 'REVOKED') return serializeDevice(before);
      const revokedAt = parseServerTime(this.clock());
      const result = await transaction.device.updateMany({
        where: { id, status: { in: REGISTERED_DEVICE_STATUSES } },
        data: { status: 'REVOKED', revokedAt },
      });
      if (result.count !== 1) {
        const current = await transaction.device.findUnique({ where: { id } });
        if (current?.status === 'REVOKED') return serializeDevice(current);
        bad('DEVICE_NOT_AVAILABLE');
      }
      await transaction.licenseLease?.updateMany?.({
        where: { deviceId: id, status: 'ACTIVE' },
        data: { status: 'REVOKED', revokedAt },
      });
      await this.audit?.record?.({
        ...context,
        action: 'DEVICE_REVOKED',
        targetType: 'DEVICE',
        targetId: id,
        before: { status: before.status },
        after: { status: 'REVOKED' },
      }, transaction);
      return serializeDevice({ ...before, status: 'REVOKED', revokedAt });
    });
  }
}

module.exports = {
  DeviceService,
  DEVICE_STATUSES,
  REGISTERED_DEVICE_STATUSES,
  normalizePublicKey,
  serializeDevice,
  verifyDeviceSignature,
};
