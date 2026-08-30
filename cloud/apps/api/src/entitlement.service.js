'use strict';

const { BadRequestException, NotFoundException } = require('@nestjs/common');

const ENTITLEMENT_STATUSES = new Set(['ACTIVE', 'EXPIRED', 'SUSPENDED', 'REVOKED']);
const GRANT_SOURCES = new Set([
  'REDEMPTION',
  'ADMIN_GRANT',
  'AGENT_GRANT',
  'PROMOTION',
  'COMPENSATION',
  'MIGRATION',
]);

function bad(code) {
  throw new BadRequestException({ code });
}

function assertId(id, code) {
  if (typeof id !== 'string' || !id.trim()) bad(code);
}

function toDate(value) {
  if (value == null) return null;
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) bad('INVALID_ENTITLEMENT_DATE');
  return date;
}

function positiveDuration(value) {
  const duration = Number(value);
  if (!Number.isInteger(duration) || duration < 1 || duration > 2147483647) {
    bad('INVALID_GRANT_DURATION');
  }
  return duration;
}

function serializeEntitlement(entitlement) {
  if (!entitlement) return null;
  const serialized = {
    id: entitlement.id,
    userId: entitlement.userId,
    productId: entitlement.productId,
    planId: entitlement.planId,
    status: entitlement.status,
    startsAt: entitlement.startsAt,
    expiresAt: entitlement.expiresAt,
    isPermanent: entitlement.isPermanent,
    suspendedAt: entitlement.suspendedAt,
    revokedAt: entitlement.revokedAt,
    lastValidatedAt: entitlement.lastValidatedAt,
    createdAt: entitlement.createdAt,
    updatedAt: entitlement.updatedAt,
  };
  if (Array.isArray(entitlement.grants)) serialized.grants = entitlement.grants.map(serializeGrant);
  return serialized;
}

function serializeGrant(grant) {
  if (!grant) return null;
  return {
    id: grant.id,
    entitlementId: grant.entitlementId,
    type: grant.type,
    durationSeconds: grant.durationSeconds,
    source: grant.source,
    redemptionCodeId: grant.redemptionCodeId,
    operatorId: grant.operatorId,
    agentId: grant.agentId,
    oldExpiresAt: grant.oldExpiresAt,
    newExpiresAt: grant.newExpiresAt,
    requestId: grant.requestId,
    createdAt: grant.createdAt,
  };
}

function grantSnapshot(entitlement) {
  return entitlement
    ? {
      id: entitlement.id,
      userId: entitlement.userId,
      productId: entitlement.productId,
      planId: entitlement.planId,
      status: entitlement.status,
      startsAt: entitlement.startsAt,
      expiresAt: entitlement.expiresAt,
      isPermanent: entitlement.isPermanent,
    }
    : null;
}

class EntitlementService {
  constructor(database, audit, clock = () => new Date()) {
    this.database = database;
    this.audit = audit;
    this.clock = clock;
  }

  async grantToUser(userId, input = {}, context = {}) {
    assertId(userId, 'INVALID_USER_ID');
    assertId(input.productId, 'INVALID_PRODUCT_ID');
    const now = toDate(this.clock());
    const source = String(context.source || 'ADMIN_GRANT').toUpperCase();
    if (!GRANT_SOURCES.has(source)) bad('INVALID_GRANT_SOURCE');

    return this.database.$transaction((transaction) => this.grantToUserInTransaction(
      transaction,
      userId,
      input,
      context,
      now,
      source,
    ));
  }

  async grantToUserInTransaction(transaction, userId, input = {}, context = {}, transactionNow, transactionSource) {
    assertId(userId, 'INVALID_USER_ID');
    assertId(input.productId, 'INVALID_PRODUCT_ID');
    const now = transactionNow ? toDate(transactionNow) : toDate(this.clock());
    const source = transactionSource || String(context.source || 'ADMIN_GRANT').toUpperCase();
    if (!GRANT_SOURCES.has(source)) bad('INVALID_GRANT_SOURCE');

      const user = await transaction.user.findUnique({
        where: { id: userId },
        select: { id: true, profile: { select: { status: true } } },
      });
      if (!user) throw new NotFoundException({ code: 'USER_NOT_FOUND' });
      if (user.profile?.status === 'DISABLED') bad('USER_DISABLED');
      if (user.profile?.status === 'SUSPENDED') bad('USER_SUSPENDED');

      const product = await transaction.product.findUnique({ where: { id: input.productId } });
      if (!product) throw new NotFoundException({ code: 'PRODUCT_NOT_FOUND' });
      if (product.status !== 'ACTIVE') bad('PRODUCT_DISABLED');

      let plan = null;
      if (input.planId !== undefined && input.planId !== null && input.planId !== '') {
        plan = await transaction.plan.findUnique({ where: { id: input.planId } });
        if (!plan) throw new NotFoundException({ code: 'PLAN_NOT_FOUND' });
        if (plan.productId !== input.productId) bad('PLAN_PRODUCT_MISMATCH');
        if (plan.status !== 'ACTIVE') bad('PLAN_DISABLED');
      }

      const existing = await transaction.entitlement.findUnique({
        where: { userId_productId: { userId, productId: input.productId } },
      });
      if (existing?.status === 'REVOKED') bad('ENTITLEMENT_REVOKED');
      if (existing?.status === 'SUSPENDED') bad('ENTITLEMENT_SUSPENDED');

      const isPermanent = input.isPermanent === true || plan?.isPermanent === true;
      if (existing?.isPermanent && !isPermanent) bad('PERMANENT_ENTITLEMENT');
      const durationSeconds = isPermanent
        ? null
        : input.durationSeconds !== undefined
          ? positiveDuration(input.durationSeconds)
          : positiveDuration(plan?.durationSeconds);

      const oldExpiresAt = toDate(existing?.expiresAt);
      const base = oldExpiresAt && oldExpiresAt > now ? oldExpiresAt : now;
      const newExpiresAt = isPermanent
        ? null
        : new Date(base.getTime() + durationSeconds * 1000);
      const planId = plan?.id ?? existing?.planId ?? null;
      const data = {
        userId,
        productId: input.productId,
        planId,
        status: 'ACTIVE',
        startsAt: existing?.startsAt ? toDate(existing.startsAt) : now,
        expiresAt: newExpiresAt,
        isPermanent,
        suspendedAt: null,
        revokedAt: null,
        lastValidatedAt: now,
      };

      const entitlement = existing
        ? await transaction.entitlement.update({ where: { id: existing.id }, data })
        : await transaction.entitlement.create({ data });
      const grant = await transaction.entitlementGrant.create({
        data: {
          entitlementId: entitlement.id,
          type: isPermanent ? 'PERMANENT' : 'DURATION',
          durationSeconds,
          source,
          redemptionCodeId: context.redemptionCodeId || null,
          operatorId: context.actorId || null,
          agentId: context.agentId || null,
          oldExpiresAt,
          newExpiresAt,
          requestId: context.requestId || 'system',
        },
      });

      await this.audit?.record?.({
        ...context,
        action: 'ENTITLEMENT_GRANTED',
        targetType: 'ENTITLEMENT',
        targetId: entitlement.id,
        before: grantSnapshot(existing),
        after: grantSnapshot(entitlement),
      }, transaction);

      return {
        entitlement: serializeEntitlement(entitlement),
        grant: serializeGrant(grant),
      };
  }

  async getById(id) {
    assertId(id, 'INVALID_ENTITLEMENT_ID');
    const entitlement = await this.database.entitlement.findUnique({ where: { id } });
    if (!entitlement) throw new NotFoundException({ code: 'ENTITLEMENT_NOT_FOUND' });
    return serializeEntitlement(entitlement);
  }

  async setStatus(id, status, context = {}) {
    assertId(id, 'INVALID_ENTITLEMENT_ID');
    const nextStatus = String(status || '').toUpperCase();
    if (!['ACTIVE', 'SUSPENDED', 'REVOKED'].includes(nextStatus)) bad('INVALID_ENTITLEMENT_STATUS');
    const now = toDate(this.clock());
    return this.database.$transaction(async (transaction) => {
      const before = await transaction.entitlement.findUnique({ where: { id } });
      if (!before) throw new NotFoundException({ code: 'ENTITLEMENT_NOT_FOUND' });
      if (before.status === 'REVOKED' && nextStatus !== 'REVOKED') bad('ENTITLEMENT_REVOKED');
      if (before.status === nextStatus) return serializeEntitlement(before);
      const entitlement = await transaction.entitlement.update({
        where: { id },
        data: {
          status: nextStatus,
          suspendedAt: nextStatus === 'SUSPENDED' ? now : null,
          revokedAt: nextStatus === 'REVOKED' ? now : null,
        },
      });
      if (nextStatus !== 'ACTIVE') {
        await transaction.licenseLease?.updateMany?.({
          where: { entitlementId: id, status: 'ACTIVE' },
          data: { status: 'REVOKED', revokedAt: now },
        });
      }
      await this.audit?.record?.({
        ...context,
        action: nextStatus === 'REVOKED' ? 'ENTITLEMENT_REVOKED' : nextStatus === 'SUSPENDED' ? 'ENTITLEMENT_SUSPENDED' : 'ENTITLEMENT_REACTIVATED',
        targetType: 'ENTITLEMENT',
        targetId: id,
        before: grantSnapshot(before),
        after: grantSnapshot(entitlement),
      }, transaction);
      return serializeEntitlement(entitlement);
    });
  }

  async list(query = {}) {
    const page = Math.max(1, Number.isInteger(Number(query.page)) ? Number(query.page) : 1);
    const pageSize = Math.min(100, Math.max(1, Number.isInteger(Number(query.pageSize)) ? Number(query.pageSize) : 20));
    const where = {};
    if (query.userId) where.userId = String(query.userId);
    if (query.productId) where.productId = String(query.productId);
    if (query.status) {
      const status = String(query.status).toUpperCase();
      if (!ENTITLEMENT_STATUSES.has(status)) bad('INVALID_ENTITLEMENT_STATUS');
      where.status = status;
    }
    const findMany = {
      where,
      orderBy: { updatedAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    };
    if (query.includeHistory === true || query.includeHistory === 'true') {
      findMany.include = { grants: { orderBy: { createdAt: 'desc' } } };
    }
    const [items, total] = await Promise.all([
      this.database.entitlement.findMany(findMany),
      this.database.entitlement.count({ where }),
    ]);
    return {
      items: items.map(serializeEntitlement),
      meta: { page, pageSize, total },
    };
  }
}

module.exports = {
  EntitlementService,
  ENTITLEMENT_STATUSES,
  GRANT_SOURCES,
  serializeEntitlement,
  serializeGrant,
};
