'use strict';

const { BadRequestException, NotFoundException } = require('@nestjs/common');

const { serializeDevice, verifyDeviceSignature } = require('./device.service');
const { evaluateClientVersion } = require('./version-policy.service');

const LEASE_STATUSES = new Set(['ACTIVE', 'EXPIRED', 'REVOKED']);
const DEFAULT_CLOCK_SKEW_SECONDS = 300;

function bad(code, details) {
  throw new BadRequestException({ code, ...(details ? { details } : {}) });
}

function assertId(value, code) {
  if (typeof value !== 'string' || !value.trim()) bad(code);
  return value.trim();
}

function optionalText(value, code, maximum = 255) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximum) bad(code);
  return value.trim();
}

function parseServerTime(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('Invalid server time');
  return date;
}

function parseClientTime(value) {
  try {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return parseServerTime(value < 100000000000 ? value * 1000 : value);
    }
    if (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value.trim())) {
      const numeric = Number(value);
      return parseServerTime(numeric < 100000000000 ? numeric * 1000 : numeric);
    }
    return parseServerTime(value);
  } catch {
    bad('INVALID_HEARTBEAT_TIMESTAMP');
  }
}

function canonicalizePayload(value) {
  if (Array.isArray(value)) return value.map(canonicalizePayload);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalizePayload(value[key])]));
  }
  return value;
}

function signedPayload(input) {
  const { signature, ...payload } = input;
  return payload;
}

function serializeLease(lease) {
  if (!lease) return null;
  return {
    id: lease.id,
    userId: lease.userId,
    entitlementId: lease.entitlementId,
    deviceId: lease.deviceId,
    instanceId: lease.instanceId,
    sessionId: lease.sessionId,
    status: lease.status,
    sequence: lease.sequence,
    issuedAt: lease.issuedAt,
    expiresAt: lease.expiresAt,
    lastHeartbeatAt: lease.lastHeartbeatAt,
    lastIp: lease.lastIp,
    createdAt: lease.createdAt,
    revokedAt: lease.revokedAt,
  };
}

function serializeEntitlementSnapshot(entitlement) {
  if (!entitlement) return null;
  return {
    id: entitlement.id,
    userId: entitlement.userId,
    productId: entitlement.productId,
    planId: entitlement.planId,
    status: entitlement.status,
    startsAt: entitlement.startsAt,
    expiresAt: entitlement.expiresAt,
    isPermanent: entitlement.isPermanent,
  };
}

function planLimits(plan) {
  return {
    maxRegisteredDevices: plan.maxRegisteredDevices,
    maxConcurrentDevices: plan.maxConcurrentDevices,
    maxInstancesPerDevice: plan.maxInstancesPerDevice,
    heartbeatRequired: plan.heartbeatRequired,
    heartbeatIntervalSeconds: plan.heartbeatIntervalSeconds,
    leaseTtlSeconds: plan.leaseTtlSeconds,
  };
}

function activeLeaseFilter(userId, now) {
  return { userId, status: 'ACTIVE', expiresAt: { gt: now } };
}

class LeaseService {
  constructor(database, audit, clock = () => new Date(), options = {}) {
    this.database = database;
    this.audit = audit;
    this.clock = clock;
    this.securityEvents = options.securityEvents;
    this.offlineGrants = options.offlineGrants;
    this.versionPolicies = options.versionPolicies;
    this.clockSkewSeconds = Number.isInteger(options.clockSkewSeconds) && options.clockSkewSeconds >= 0
      ? options.clockSkewSeconds
      : DEFAULT_CLOCK_SKEW_SECONDS;
  }

  async acquire(userId, input = {}, context = {}) {
    const id = assertId(userId, 'INVALID_USER_ID');
    const request = this.normalizeRequest(input, false);
    const now = parseServerTime(this.clock());
    try {
      return await this.database.$transaction(async (transaction) => {
      const user = await this.getUser(transaction, id);
      const device = await this.getDevice(transaction, id, request.deviceId);
      this.assertDeviceActive(device);
      this.assertSignature(device, input);
      this.assertTimestamp(request.timestamp, now);
      const entitlement = await this.getEntitlement(transaction, id, input.productId, now);
      const plan = entitlement.plan;
      const clientVersionPolicy = await this.checkClientVersion(transaction, entitlement.productId, request.appVersion);

      await this.expireActiveLeases(transaction, id, now);
      const existing = await transaction.licenseLease.findFirst({
        where: { userId: id, deviceId: request.deviceId, instanceId: request.instanceId, sessionId: request.sessionId, status: 'ACTIVE' },
        orderBy: { issuedAt: 'desc' },
      });
      const ttl = this.leaseTtl(plan);
      if (existing && parseServerTime(existing.expiresAt) > now) {
        const refreshed = await transaction.licenseLease.update({
          where: { id: existing.id },
          data: { expiresAt: new Date(now.getTime() + ttl * 1000), lastHeartbeatAt: now, lastIp: context.ip || null },
        });
        return this.response({ now, user, entitlement, device, lease: refreshed, activeLeases: await this.activeLeases(transaction, id, now), plan, clientVersionPolicy });
      }

      let activeLeases = await this.activeLeases(transaction, id, now);
      activeLeases = await this.enforceConcurrency(transaction, activeLeases, request.deviceId, request.instanceId, plan, now, context);
      const lease = await transaction.licenseLease.create({
        data: {
          userId: id,
          entitlementId: entitlement.id,
          deviceId: request.deviceId,
          instanceId: request.instanceId,
          sessionId: request.sessionId,
          status: 'ACTIVE',
          sequence: 0,
          issuedAt: now,
          expiresAt: new Date(now.getTime() + ttl * 1000),
          lastHeartbeatAt: now,
          lastIp: context.ip || null,
        },
      });
      await this.audit?.record?.({
        ...context,
        actorType: 'USER',
        actorId: id,
        action: 'LEASE_ACQUIRED',
        targetType: 'LICENSE_LEASE',
        targetId: lease.id,
        before: null,
        after: { id: lease.id, userId: id, deviceId: request.deviceId, instanceId: request.instanceId, status: lease.status },
      }, transaction);
      return this.response({ now, user, entitlement, device, lease, activeLeases: [...activeLeases, lease], plan, clientVersionPolicy });
      }, { isolationLevel: 'Serializable' });
    } catch (error) {
      await this.recordSecurityFailure(error, id, input, context, 'acquire');
      throw error;
    }
  }

  async heartbeat(userId, input = {}, context = {}) {
    const id = assertId(userId, 'INVALID_USER_ID');
    const request = this.normalizeRequest(input, true);
    const now = parseServerTime(this.clock());
    try {
      return await this.database.$transaction(async (transaction) => {
      const user = await this.getUser(transaction, id);
      const device = await this.getDevice(transaction, id, request.deviceId);
      this.assertDeviceActive(device);
      this.assertSignature(device, input);
      this.assertTimestamp(request.timestamp, now);
      const current = await transaction.licenseLease.findUnique({ where: { id: request.leaseId } });
      if (!current || current.userId !== id || current.deviceId !== request.deviceId || current.instanceId !== request.instanceId || current.sessionId !== request.sessionId) {
        throw new NotFoundException({ code: 'LEASE_NOT_FOUND' });
      }
      if (current.status === 'REVOKED') bad('LEASE_REVOKED');
      if (current.status === 'EXPIRED' || parseServerTime(current.expiresAt) <= now) {
        await transaction.licenseLease.updateMany({ where: { id: current.id, status: 'ACTIVE' }, data: { status: 'EXPIRED' } });
        bad('LEASE_EXPIRED');
      }
      const entitlement = await this.getEntitlement(transaction, id, input.productId, now);
      const plan = entitlement.plan;
      const clientVersionPolicy = await this.checkClientVersion(transaction, entitlement.productId, request.appVersion);
      if (request.sequence <= Number(current.sequence)) bad('HEARTBEAT_REPLAY');
      const renewedUntil = new Date(now.getTime() + this.leaseTtl(plan) * 1000);
      const updated = await transaction.licenseLease.updateMany({
        where: {
          id: current.id,
          userId: id,
          deviceId: request.deviceId,
          instanceId: request.instanceId,
          sessionId: request.sessionId,
          status: 'ACTIVE',
          sequence: { lt: request.sequence },
          expiresAt: { gt: now },
        },
        data: { sequence: request.sequence, lastHeartbeatAt: now, expiresAt: renewedUntil, lastIp: context.ip || null },
      });
      if (updated.count !== 1) {
        const raced = await transaction.licenseLease.findUnique({ where: { id: current.id } });
        if (raced?.status === 'REVOKED') bad('LEASE_REVOKED');
        if (raced?.status === 'EXPIRED' || (raced && parseServerTime(raced.expiresAt) <= now)) bad('LEASE_EXPIRED');
        if (!raced || Number(raced.sequence) >= request.sequence) bad('HEARTBEAT_REPLAY');
        bad('LEASE_NOT_ACTIVE');
      }
      const lease = await transaction.licenseLease.findUnique({ where: { id: current.id } });
      return this.response({ now, user, entitlement, device, lease, activeLeases: await this.activeLeases(transaction, id, now), plan, clientVersionPolicy });
      }, { isolationLevel: 'Serializable' });
    } catch (error) {
      await this.recordSecurityFailure(error, id, input, context, 'heartbeat');
      throw error;
    }
  }

  async release(userId, leaseId, context = {}) {
    const user = assertId(userId, 'INVALID_USER_ID');
    const id = assertId(leaseId, 'INVALID_LEASE_ID');
    const now = parseServerTime(this.clock());
    return this.database.$transaction(async (transaction) => {
      const current = await transaction.licenseLease.findUnique({ where: { id } });
      if (!current || current.userId !== user) throw new NotFoundException({ code: 'LEASE_NOT_FOUND' });
      if (current.status === 'REVOKED') return serializeLease(current);
      const result = await transaction.licenseLease.updateMany({ where: { id, userId: user, status: 'ACTIVE' }, data: { status: 'REVOKED', revokedAt: now } });
      if (result.count !== 1) {
        const raced = await transaction.licenseLease.findUnique({ where: { id } });
        if (raced?.status === 'REVOKED') return serializeLease(raced);
        bad('LEASE_NOT_ACTIVE');
      }
      await this.audit?.record?.({
        ...context,
        actorType: 'USER',
        actorId: user,
        action: 'LEASE_RELEASED',
        targetType: 'LICENSE_LEASE',
        targetId: id,
        before: { status: current.status },
        after: { status: 'REVOKED' },
      }, transaction);
      return serializeLease({ ...current, status: 'REVOKED', revokedAt: now });
    });
  }

  async getStatus(userId, input = {}) {
    const id = assertId(userId, 'INVALID_USER_ID');
    const now = parseServerTime(this.clock());
    const user = await this.getUser(this.database, id);
    const entitlement = await this.getEntitlement(this.database, id, input.productId, now, { allowMissing: true });
    const device = input.deviceId ? await this.getDevice(this.database, id, assertId(input.deviceId, 'INVALID_DEVICE_ID'), { allowMissing: true }) : null;
    const leases = await this.activeLeases(this.database, id, now);
    const plan = entitlement?.plan || {};
    const policy = entitlement && this.versionPolicies ? await this.versionPolicies.getActive(entitlement.productId) : null;
    const clientVersionPolicy = input.appVersion ? evaluateClientVersion(String(input.appVersion), policy) : { status: 'SUPPORTED', policy: null };
    return {
      serverTime: now,
      user: { id: user.id, status: user.profile?.status || 'ACTIVE' },
      entitlement: serializeEntitlementSnapshot(entitlement),
      device: serializeDevice(device),
      lease: serializeLease(leases.find((lease) => !device || lease.deviceId === device.id)),
      features: plan.features || {},
      limits: planLimits(plan),
      offline: { graceSeconds: plan.offlineGraceSeconds || 0 },
      clientVersionPolicy,
    };
  }

  normalizeRequest(input, withHeartbeat) {
    const deviceId = assertId(input.deviceId, 'INVALID_DEVICE_ID');
    const instanceId = assertId(input.instanceId, 'INVALID_INSTANCE_ID');
    const sessionId = assertId(input.sessionId, 'INVALID_SESSION_ID');
    const timestamp = parseClientTime(input.timestamp);
    const nonce = optionalText(input.nonce, 'INVALID_HEARTBEAT_NONCE', 255);
    if (!nonce) bad('INVALID_HEARTBEAT_NONCE');
    const appVersion = optionalText(input.appVersion, 'INVALID_CLIENT_VERSION', 64);
    if (!appVersion) bad('INVALID_CLIENT_VERSION');
    const signature = optionalText(input.signature, 'INVALID_DEVICE_SIGNATURE', 4096);
    if (!signature) bad('INVALID_DEVICE_SIGNATURE');
    const result = { deviceId, instanceId, sessionId, timestamp, nonce, appVersion, signature };
    if (withHeartbeat) {
      const sequence = Number(input.sequence);
      if (!Number.isSafeInteger(sequence) || sequence < 1) bad('INVALID_HEARTBEAT_SEQUENCE');
      result.leaseId = assertId(input.leaseId, 'INVALID_LEASE_ID');
      result.sequence = sequence;
    }
    return result;
  }

  assertTimestamp(timestamp, now) {
    if (Math.abs(parseServerTime(timestamp).getTime() - now.getTime()) > this.clockSkewSeconds * 1000) bad('INVALID_HEARTBEAT_TIMESTAMP');
  }

  assertSignature(device, input) {
    if (!verifyDeviceSignature(device.publicKey, signedPayload(input), input.signature)) bad('INVALID_DEVICE_SIGNATURE');
  }

  async getUser(transaction, userId) {
    const user = await transaction.user.findUnique({ where: { id: userId }, select: { id: true, profile: { select: { status: true } } } });
    if (!user) throw new NotFoundException({ code: 'USER_NOT_FOUND' });
    if (user.profile?.status === 'DISABLED') bad('USER_DISABLED');
    if (user.profile?.status === 'SUSPENDED') bad('USER_SUSPENDED');
    return user;
  }

  async getDevice(transaction, userId, deviceId, { allowMissing = false } = {}) {
    const device = await transaction.device.findUnique({ where: { id: deviceId } });
    if (!device || device.userId !== userId) {
      if (allowMissing) return null;
      throw new NotFoundException({ code: 'DEVICE_NOT_FOUND' });
    }
    return device;
  }

  assertDeviceActive(device) {
    if (device.status === 'REVOKED') bad('DEVICE_REVOKED');
    if (device.status === 'BLOCKED') bad('DEVICE_BLOCKED');
    if (device.status !== 'ACTIVE') bad('DEVICE_NOT_ACTIVE');
  }

  async getEntitlement(transaction, userId, productId, now, { allowMissing = false } = {}) {
    const entitlement = await transaction.entitlement.findFirst({
      where: { userId, status: 'ACTIVE', ...(productId ? { productId: assertId(productId, 'INVALID_PRODUCT_ID') } : {}) },
      orderBy: { updatedAt: 'desc' },
      include: { plan: true },
    });
    if (!entitlement) {
      const existing = await transaction.entitlement.findFirst({
        where: { userId, ...(productId ? { productId: assertId(productId, 'INVALID_PRODUCT_ID') } : {}) },
        orderBy: { updatedAt: 'desc' },
      });
      if (existing?.status === 'SUSPENDED') bad('ENTITLEMENT_SUSPENDED');
      if (existing?.status === 'REVOKED') bad('ENTITLEMENT_REVOKED');
      if (existing?.status === 'EXPIRED') bad('ENTITLEMENT_EXPIRED');
      if (allowMissing) return null;
      throw new NotFoundException({ code: 'ENTITLEMENT_REQUIRED' });
    }
    if (entitlement.status === 'SUSPENDED') bad('ENTITLEMENT_SUSPENDED');
    if (entitlement.status !== 'ACTIVE' || (!entitlement.isPermanent && (!entitlement.expiresAt || parseServerTime(entitlement.expiresAt) <= now))) bad('ENTITLEMENT_EXPIRED');
    if (!entitlement.plan) bad('PLAN_REQUIRED');
    if (entitlement.plan.status !== 'ACTIVE') bad('PLAN_DISABLED');
    return entitlement;
  }

  async checkClientVersion(transaction, productId, appVersion) {
    const policy = this.versionPolicies ? await this.versionPolicies.getActive(productId, transaction) : null;
    const result = evaluateClientVersion(appVersion, policy);
    if (result.status === 'UPDATE_REQUIRED') bad('CLIENT_UPDATE_REQUIRED', { policy: result.policy });
    return result;
  }

  async recordSecurityFailure(error, userId, input, context, route) {
    const response = typeof error?.getResponse === 'function' ? error.getResponse() : error?.response;
    const code = typeof response === 'object' && response ? response.code : null;
    const mapping = {
      INVALID_DEVICE_SIGNATURE: ['INVALID_DEVICE_SIGNATURE', 'HIGH'],
      HEARTBEAT_REPLAY: ['HEARTBEAT_REPLAY', 'HIGH'],
      CLIENT_UPDATE_REQUIRED: ['CLIENT_VERSION_BLOCKED', 'MEDIUM'],
      CONCURRENT_DEVICE_LIMIT: ['CONCURRENT_LIMIT_EXCEEDED', 'MEDIUM'],
      CONCURRENT_INSTANCE_LIMIT: ['CONCURRENT_LIMIT_EXCEEDED', 'MEDIUM'],
    };
    const [type, severity] = mapping[code] || [];
    if (!type || !this.securityEvents?.create) return;
    try {
      await this.securityEvents.create({
        type,
        severity,
        userId,
        deviceId: typeof input?.deviceId === 'string' ? input.deviceId : null,
        ip: context?.ip,
        metadata: { route, productId: input?.productId || null, code },
      });
    } catch {
      // Security telemetry must never replace the original authorization error.
    }
  }

  leaseTtl(plan) {
    const ttl = Number(plan.leaseTtlSeconds);
    if (!Number.isSafeInteger(ttl) || ttl < 1) bad('INVALID_LEASE_TTL');
    return ttl;
  }

  async expireActiveLeases(transaction, userId, now) {
    await transaction.licenseLease.updateMany({ where: { userId, status: 'ACTIVE', expiresAt: { lte: now } }, data: { status: 'EXPIRED' } });
  }

  async activeLeases(transaction, userId, now) {
    return transaction.licenseLease.findMany({ where: activeLeaseFilter(userId, now), orderBy: { issuedAt: 'asc' } });
  }

  async enforceConcurrency(transaction, activeLeases, deviceId, instanceId, plan, now, context = {}) {
    const maxDevices = Math.max(1, Number(plan.maxConcurrentDevices || 1));
    const maxInstances = Math.max(1, Number(plan.maxInstancesPerDevice || 1));
    const policy = String(plan.concurrencyPolicy || 'DENY_NEW').toUpperCase();
    let leases = [...activeLeases];
    const activeDevices = new Set(leases.map((lease) => lease.deviceId));
    if (!activeDevices.has(deviceId) && activeDevices.size >= maxDevices) {
      if (policy === 'ASK_USER') bad('CONCURRENT_DEVICE_LIMIT', { policy });
      if (policy !== 'KICK_OLDEST') bad('CONCURRENT_DEVICE_LIMIT');
      const oldest = leases.find((lease) => lease.deviceId !== deviceId);
      if (oldest) {
        await transaction.licenseLease.updateMany({ where: { deviceId: oldest.deviceId, status: 'ACTIVE' }, data: { status: 'REVOKED', revokedAt: now } });
        await this.audit?.record?.({
          ...context,
          actorType: 'USER',
          action: 'LEASE_KICKED_OLDEST',
          targetType: 'LICENSE_LEASE',
          targetId: oldest.id,
          before: { id: oldest.id, deviceId: oldest.deviceId, status: oldest.status },
          after: { id: oldest.id, deviceId: oldest.deviceId, status: 'REVOKED', reason: 'KICK_OLDEST' },
        }, transaction);
        leases = leases.filter((lease) => lease.deviceId !== oldest.deviceId);
      }
    }
    const sameDevice = leases.filter((lease) => lease.deviceId === deviceId);
    if (sameDevice.length >= maxInstances) {
      if (policy === 'ASK_USER') bad('CONCURRENT_INSTANCE_LIMIT', { policy });
      if (policy !== 'KICK_OLDEST') bad('CONCURRENT_INSTANCE_LIMIT');
      const oldest = sameDevice[0];
      await transaction.licenseLease.updateMany({ where: { id: oldest.id, status: 'ACTIVE' }, data: { status: 'REVOKED', revokedAt: now } });
      await this.audit?.record?.({
        ...context,
        actorType: 'USER',
        action: 'LEASE_KICKED_OLDEST',
        targetType: 'LICENSE_LEASE',
        targetId: oldest.id,
        before: { id: oldest.id, deviceId: oldest.deviceId, instanceId: oldest.instanceId, status: oldest.status },
        after: { id: oldest.id, deviceId: oldest.deviceId, instanceId: oldest.instanceId, status: 'REVOKED', reason: 'KICK_OLDEST' },
      }, transaction);
      leases = leases.filter((lease) => lease.id !== oldest.id);
    }
    return leases;
  }

  response({ now, user, entitlement, device, lease, activeLeases, plan, clientVersionPolicy }) {
    const offlineGrant = this.offlineGrants?.issue?.({
      userId: user.id,
      deviceId: device.id,
      productId: entitlement.productId,
      features: plan.features || {},
      entitlementExpiresAt: entitlement.isPermanent ? null : entitlement.expiresAt,
      offlineGraceSeconds: plan.offlineGraceSeconds || 0,
      policyVersion: clientVersionPolicy?.policy?.id || 'default',
      issuedAt: now,
    }) || null;
    return {
      serverTime: now,
      user: { id: user.id, status: user.profile?.status || 'ACTIVE' },
      entitlement: serializeEntitlementSnapshot(entitlement),
      device: serializeDevice(device),
      lease: serializeLease(lease),
      features: plan.features || {},
      limits: planLimits(plan),
      offline: { graceSeconds: plan.offlineGraceSeconds || 0 },
      clientVersionPolicy: clientVersionPolicy || { status: 'SUPPORTED', policy: null },
      offlineGrant,
      online: { devices: new Set(activeLeases.map((item) => item.deviceId)).size, leases: activeLeases.length },
    };
  }
}

module.exports = {
  LeaseService,
  LEASE_STATUSES,
  canonicalizePayload,
  serializeLease,
  serializeEntitlementSnapshot,
};
