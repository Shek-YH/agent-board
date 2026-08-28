'use strict';

const crypto = require('node:crypto');
const { BadRequestException, NotFoundException } = require('@nestjs/common');

const BATCH_STATUSES = new Set(['ACTIVE', 'REVOKED', 'EXPIRED']);
const CODE_STATUSES = new Set(['UNUSED', 'REDEEMED', 'REVOKED', 'EXPIRED']);
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function bad(code) {
  throw new BadRequestException({ code });
}

function assertId(id, code) {
  if (typeof id !== 'string' || !id.trim()) bad(code);
}

function requiredText(value, code) {
  if (typeof value !== 'string' || !value.trim()) bad(code);
  return value.trim();
}

function parseQuantity(value) {
  const quantity = Number(value);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10000) bad('INVALID_REDEMPTION_QUANTITY');
  return quantity;
}

function parseDate(value, code) {
  if (value === undefined || value === null || value === '') return null;
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) bad(code);
  return date;
}

function normalizeCode(value) {
  return requiredText(value, 'INVALID_REDEMPTION_CODE_INPUT').toUpperCase();
}

function hashRedemptionCode(code, pepper) {
  if (typeof pepper !== 'string' || !pepper) throw new Error('Redemption pepper is not configured');
  return crypto.createHmac('sha256', pepper).update(normalizeCode(code), 'utf8').digest('hex');
}

function generateCode(randomBytes = crypto.randomBytes) {
  const bytes = randomBytes(20);
  return Array.from(bytes, (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join('');
}

function serializeBatch(batch) {
  if (!batch) return null;
  return {
    id: batch.id,
    name: batch.name,
    productId: batch.productId,
    planId: batch.planId,
    quantity: batch.quantity,
    ownerAgentId: batch.ownerAgentId,
    createdBy: batch.createdBy,
    expiresAt: batch.expiresAt,
    status: batch.status,
    createdAt: batch.createdAt,
    updatedAt: batch.updatedAt,
  };
}

function serializeCode(code) {
  if (!code) return null;
  return {
    id: code.id,
    batchId: code.batchId,
    codeLast4: code.codeLast4,
    planId: code.planId,
    durationSeconds: code.durationSeconds,
    status: code.status,
    ownerAgentId: code.ownerAgentId,
    createdBy: code.createdBy,
    redeemedByUserId: code.redeemedByUserId,
    redeemedAt: code.redeemedAt,
    codeExpiresAt: code.codeExpiresAt,
    revokedAt: code.revokedAt,
    createdAt: code.createdAt,
    updatedAt: code.updatedAt,
  };
}

function csvValue(value) {
  const text = value == null ? '' : value instanceof Date ? value.toISOString() : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function jsonSafe(value) {
  return JSON.parse(JSON.stringify(value));
}

class RedemptionService {
  constructor(database, entitlements, audit, pepper, clock = () => new Date(), randomBytes = crypto.randomBytes) {
    this.database = database;
    this.entitlements = entitlements;
    this.audit = audit;
    this.pepper = pepper;
    this.clock = clock;
    this.randomBytes = randomBytes;
  }

  async createBatch(input = {}, context = {}) {
    assertId(input.productId, 'INVALID_PRODUCT_ID');
    assertId(input.planId, 'INVALID_PLAN_ID');
    const name = requiredText(input.name, 'INVALID_BATCH_NAME');
    const quantity = parseQuantity(input.quantity);
    const expiresAt = parseDate(input.expiresAt, 'INVALID_BATCH_EXPIRY');
    const now = parseDate(this.clock(), 'INVALID_SERVER_TIME');

    return this.database.$transaction(async (transaction) => {
      const product = await transaction.product.findUnique({ where: { id: input.productId } });
      if (!product) throw new NotFoundException({ code: 'PRODUCT_NOT_FOUND' });
      if (product.status !== 'ACTIVE') bad('PRODUCT_DISABLED');
      const plan = await transaction.plan.findUnique({ where: { id: input.planId } });
      if (!plan) throw new NotFoundException({ code: 'PLAN_NOT_FOUND' });
      if (plan.productId !== input.productId) bad('PLAN_PRODUCT_MISMATCH');
      if (plan.status !== 'ACTIVE') bad('PLAN_DISABLED');

      const batch = await transaction.redemptionBatch.create({
        data: {
          name,
          productId: input.productId,
          planId: input.planId,
          quantity,
          ownerAgentId: input.ownerAgentId || null,
          createdBy: context.actorId || 'system',
          expiresAt,
          status: 'ACTIVE',
        },
      });
      const codes = [];
      for (let index = 0; index < quantity; index += 1) {
        const plaintext = generateCode(this.randomBytes);
        const stored = await transaction.redemptionCode.create({
          data: {
            batchId: batch.id,
            codeHash: hashRedemptionCode(plaintext, this.pepper),
            codeLast4: plaintext.slice(-4),
            planId: plan.id,
            durationSeconds: plan.isPermanent ? null : plan.durationSeconds,
            status: 'UNUSED',
            ownerAgentId: input.ownerAgentId || null,
            createdBy: context.actorId || 'system',
            codeExpiresAt: expiresAt,
          },
        });
        codes.push({
          id: stored.id,
          code: plaintext,
          codeLast4: stored.codeLast4,
          codeExpiresAt: stored.codeExpiresAt,
        });
      }

      const csv = [
        'code,codeLast4,codeExpiresAt',
        ...codes.map((item) => [item.code, item.codeLast4, item.codeExpiresAt].map(csvValue).join(',')),
      ].join('\r\n');

      await this.audit?.record?.({
        ...context,
        action: 'REDEMPTION_BATCH_CREATED',
        targetType: 'REDEMPTION_BATCH',
        targetId: batch.id,
        before: null,
        after: { ...serializeBatch(batch), codeCount: quantity },
      }, transaction);
      return { batch: serializeBatch(batch), codes, csv };
    });
  }

  async redeem(userId, input = {}) {
    assertId(userId, 'INVALID_USER_ID');
    const code = normalizeCode(input.code);
    const requestId = requiredText(input.requestId, 'INVALID_REDEMPTION_REQUEST_ID');
    const codeHash = hashRedemptionCode(code, this.pepper);
    const existingRequest = await this.database.redemptionRequest.findUnique({ where: { requestId } });
    if (existingRequest) {
      if (existingRequest.userId !== userId || existingRequest.codeHash !== codeHash) bad('IDEMPOTENCY_KEY_REUSED');
      return existingRequest.response;
    }
    const now = parseDate(this.clock(), 'INVALID_SERVER_TIME');

    try {
      return await this.database.$transaction(async (transaction) => {
        const concurrentRequest = await transaction.redemptionRequest.findUnique({ where: { requestId } });
        if (concurrentRequest) {
          if (concurrentRequest.userId !== userId || concurrentRequest.codeHash !== codeHash) bad('IDEMPOTENCY_KEY_REUSED');
          return concurrentRequest.response;
        }
        const user = await transaction.user.findUnique({
          where: { id: userId },
          select: { id: true, profile: { select: { status: true } } },
        });
        if (!user) throw new NotFoundException({ code: 'USER_NOT_FOUND' });
        if (user.profile?.status === 'DISABLED') bad('USER_DISABLED');

        const stored = await transaction.redemptionCode.findUnique({ where: { codeHash } });
        if (!stored) bad('INVALID_REDEMPTION_CODE');
        if (stored.status === 'REDEEMED') bad('REDEMPTION_ALREADY_USED');
        if (stored.status === 'REVOKED') bad('REDEMPTION_REVOKED');
        if (stored.status === 'EXPIRED') bad('REDEMPTION_EXPIRED');
        if (!CODE_STATUSES.has(stored.status)) bad('INVALID_REDEMPTION_CODE');
        if (stored.codeExpiresAt && parseDate(stored.codeExpiresAt, 'INVALID_CODE_EXPIRY') <= now) {
          const expired = await transaction.redemptionCode.updateMany({
            where: { id: stored.id, status: 'UNUSED' },
            data: { status: 'EXPIRED' },
          });
          if (expired.count !== 1) {
            const current = await transaction.redemptionCode.findUnique({ where: { id: stored.id } });
            if (current?.status === 'REDEEMED') bad('REDEMPTION_ALREADY_USED');
            if (current?.status === 'REVOKED') bad('REDEMPTION_REVOKED');
            if (current?.status === 'EXPIRED') bad('REDEMPTION_EXPIRED');
            bad('REDEMPTION_CODE_NOT_AVAILABLE');
          }
          bad('REDEMPTION_EXPIRED');
        }

        const plan = await transaction.plan.findUnique({ where: { id: stored.planId } });
        if (!plan) throw new NotFoundException({ code: 'PLAN_NOT_FOUND' });
        if (plan.status !== 'ACTIVE') bad('PLAN_DISABLED');
        const product = await transaction.product.findUnique({ where: { id: plan.productId } });
        if (!product) throw new NotFoundException({ code: 'PRODUCT_NOT_FOUND' });
        if (product.status !== 'ACTIVE') bad('PRODUCT_DISABLED');

        const claimed = await transaction.redemptionCode.updateMany({
          where: { id: stored.id, status: 'UNUSED' },
          data: {
            status: 'REDEEMED',
            redeemedByUserId: userId,
            redeemedAt: now,
          },
        });
        if (claimed.count !== 1) {
          const racedRequest = await transaction.redemptionRequest.findUnique({ where: { requestId } });
          if (racedRequest) {
            if (racedRequest.userId !== userId || racedRequest.codeHash !== codeHash) bad('IDEMPOTENCY_KEY_REUSED');
            return racedRequest.response;
          }
          bad('REDEMPTION_ALREADY_USED');
        }

        const granted = await this.entitlements.grantToUserInTransaction(
          transaction,
          userId,
          { productId: plan.productId, planId: plan.id, durationSeconds: stored.durationSeconds },
          { source: 'REDEMPTION', redemptionCodeId: stored.id, requestId, actorId: userId, actorType: 'USER' },
        );
        const response = {
          codeId: stored.id,
          entitlement: jsonSafe(granted.entitlement),
          grant: jsonSafe(granted.grant),
        };
        await this.audit?.record?.({
          actorType: 'USER',
          actorId: userId,
          action: 'REDEMPTION_REDEEMED',
          targetType: 'REDEMPTION_CODE',
          targetId: stored.id,
          requestId,
          before: { status: 'UNUSED' },
          after: { status: 'REDEEMED', entitlementId: granted.entitlement.id },
        }, transaction);
        await transaction.redemptionRequest.create({
          data: {
            requestId,
            userId,
            codeId: stored.id,
            codeHash,
            entitlementId: granted.entitlement.id,
            grantId: granted.grant.id,
            response,
          },
        });
        return response;
      });
    } catch (error) {
      if (error?.code === 'P2002') {
        const racedRequest = await this.database.redemptionRequest.findUnique({ where: { requestId } });
        if (racedRequest) {
          if (racedRequest.userId !== userId || racedRequest.codeHash !== codeHash) bad('IDEMPOTENCY_KEY_REUSED');
          return racedRequest.response;
        }
      }
      throw error;
    }
  }

  async listBatches(query = {}) {
    const batches = await this.database.redemptionBatch.findMany({
      where: query.status ? { status: String(query.status).toUpperCase() } : {},
      orderBy: { createdAt: 'desc' },
    });
    return { items: batches.map(serializeBatch) };
  }

  async listCodes(query = {}) {
    const where = {};
    if (query.batchId) where.batchId = String(query.batchId);
    if (query.status) {
      const status = String(query.status).toUpperCase();
      if (!CODE_STATUSES.has(status)) bad('INVALID_REDEMPTION_STATUS');
      where.status = status;
    }
    const codes = await this.database.redemptionCode.findMany({ where, orderBy: { createdAt: 'desc' } });
    return { items: codes.map(serializeCode) };
  }

  async revokeCode(id, context = {}) {
    assertId(id, 'INVALID_REDEMPTION_CODE_ID');
    return this.database.$transaction(async (transaction) => {
      const before = await transaction.redemptionCode.findUnique({ where: { id } });
      if (!before) throw new NotFoundException({ code: 'REDEMPTION_CODE_NOT_FOUND' });
      if (before.status === 'REDEEMED') bad('REDEMPTION_ALREADY_USED');
      if (before.status === 'REVOKED') return serializeCode(before);
      const revokedAt = parseDate(this.clock(), 'INVALID_SERVER_TIME');
      const claimed = await transaction.redemptionCode.updateMany({
        where: { id, status: 'UNUSED' },
        data: { status: 'REVOKED', revokedAt },
      });
      if (claimed.count !== 1) {
        const current = await transaction.redemptionCode.findUnique({ where: { id } });
        if (current?.status === 'REDEEMED') bad('REDEMPTION_ALREADY_USED');
        if (current?.status === 'REVOKED') return serializeCode(current);
        if (current?.status === 'EXPIRED') bad('REDEMPTION_EXPIRED');
        bad('REDEMPTION_CODE_NOT_AVAILABLE');
      }
      const after = { ...before, status: 'REVOKED', revokedAt };
      await this.audit?.record?.({
        ...context,
        action: 'REDEMPTION_CODE_REVOKED',
        targetType: 'REDEMPTION_CODE',
        targetId: id,
        before: { status: before.status },
        after: { status: after.status },
      }, transaction);
      return serializeCode(after);
    });
  }
}

module.exports = {
  RedemptionService,
  BATCH_STATUSES,
  CODE_STATUSES,
  hashRedemptionCode,
  generateCode,
  serializeBatch,
  serializeCode,
};
