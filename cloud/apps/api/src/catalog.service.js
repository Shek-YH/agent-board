'use strict';

const { BadRequestException, NotFoundException } = require('@nestjs/common');

const PRODUCT_STATUSES = new Set(['ACTIVE', 'DISABLED']);
const PLAN_STATUSES = new Set(['ACTIVE', 'DISABLED']);
const CONCURRENCY_POLICIES = new Set(['REJECT', 'KICK_OLDEST']);

function bad(code) {
  throw new BadRequestException({ code });
}

function normalizeCode(value, code) {
  if (typeof value !== 'string') bad(code);
  const normalized = value.trim().toUpperCase();
  if (!normalized || !/^[A-Z0-9][A-Z0-9_-]*$/.test(normalized)) bad(code);
  return normalized;
}

function requiredName(value, code) {
  if (typeof value !== 'string' || !value.trim()) bad(code);
  return value.trim();
}

function integer(value, fallback, { minimum = 0, maximum = 2147483647, code = 'INVALID_PLAN_VALUE' } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) bad(code);
  return parsed;
}

function optionalDuration(value, isPermanent) {
  if (isPermanent) {
    if (value !== undefined && value !== null && value !== '') bad('INVALID_PLAN_DURATION');
    return null;
  }
  return integer(value, null, { minimum: 1, code: 'INVALID_PLAN_DURATION' });
}

function plainFeatures(value) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) bad('INVALID_PLAN_FEATURES');
  return value;
}

function status(value, allowed, fallback, code) {
  const normalized = value === undefined || value === null || value === ''
    ? fallback
    : String(value).toUpperCase();
  if (!allowed.has(normalized)) bad(code);
  return normalized;
}

function serializeProduct(product) {
  if (!product) return null;
  return {
    id: product.id,
    code: product.code,
    name: product.name,
    status: product.status,
    createdAt: product.createdAt,
    updatedAt: product.updatedAt,
  };
}

function serializePlan(plan) {
  if (!plan) return null;
  return {
    id: plan.id,
    productId: plan.productId,
    code: plan.code,
    name: plan.name,
    durationSeconds: plan.durationSeconds,
    isPermanent: plan.isPermanent,
    maxRegisteredDevices: plan.maxRegisteredDevices,
    maxConcurrentDevices: plan.maxConcurrentDevices,
    maxInstancesPerDevice: plan.maxInstancesPerDevice,
    heartbeatRequired: plan.heartbeatRequired,
    heartbeatIntervalSeconds: plan.heartbeatIntervalSeconds,
    leaseTtlSeconds: plan.leaseTtlSeconds,
    offlineGraceSeconds: plan.offlineGraceSeconds,
    deviceResetLimit: plan.deviceResetLimit,
    deviceResetWindowDays: plan.deviceResetWindowDays,
    concurrencyPolicy: plan.concurrencyPolicy,
    features: plan.features || {},
    agentCostCredits: plan.agentCostCredits,
    status: plan.status,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
  };
}

function assertId(id, code) {
  if (typeof id !== 'string' || !id.trim()) bad(code);
}

class CatalogService {
  constructor(database, audit) {
    this.database = database;
    this.audit = audit;
  }

  async createProduct(input = {}, context = {}) {
    const data = {
      code: normalizeCode(input.code, 'INVALID_PRODUCT_CODE'),
      name: requiredName(input.name, 'INVALID_PRODUCT_NAME'),
      status: status(input.status, PRODUCT_STATUSES, 'ACTIVE', 'INVALID_PRODUCT_STATUS'),
    };
    const product = await this.database.product.create({ data });
    await this.audit?.record?.({
      ...context,
      action: 'PRODUCT_CREATED',
      targetType: 'PRODUCT',
      targetId: product.id,
      before: null,
      after: serializeProduct(product),
    });
    return serializeProduct(product);
  }

  async listProducts() {
    const products = await this.database.product.findMany({ orderBy: { createdAt: 'desc' } });
    return { items: products.map(serializeProduct) };
  }

  async getProduct(id) {
    assertId(id, 'INVALID_PRODUCT_ID');
    const product = await this.database.product.findUnique({ where: { id } });
    if (!product) throw new NotFoundException({ code: 'PRODUCT_NOT_FOUND' });
    return serializeProduct(product);
  }

  async updateProduct(id, changes = {}, context = {}) {
    assertId(id, 'INVALID_PRODUCT_ID');
    const before = await this.database.product.findUnique({ where: { id } });
    if (!before) throw new NotFoundException({ code: 'PRODUCT_NOT_FOUND' });
    const data = {};
    if (changes.name !== undefined) data.name = requiredName(changes.name, 'INVALID_PRODUCT_NAME');
    if (changes.status !== undefined) data.status = status(changes.status, PRODUCT_STATUSES, before.status, 'INVALID_PRODUCT_STATUS');
    if (!Object.keys(data).length) bad('NO_PRODUCT_CHANGES');
    const product = await this.database.product.update({ where: { id }, data });
    await this.audit?.record?.({
      ...context,
      action: 'PRODUCT_UPDATED',
      targetType: 'PRODUCT',
      targetId: id,
      before: serializeProduct(before),
      after: serializeProduct(product),
    });
    return serializeProduct(product);
  }

  async createPlan(input = {}, context = {}) {
    const productId = input.productId;
    assertId(productId, 'INVALID_PRODUCT_ID');
    const product = await this.database.product.findUnique({ where: { id: productId } });
    if (!product) throw new NotFoundException({ code: 'PRODUCT_NOT_FOUND' });
    if (product.status !== 'ACTIVE') bad('PRODUCT_DISABLED');

    const isPermanent = input.isPermanent === true;
    const data = {
      productId,
      code: normalizeCode(input.code, 'INVALID_PLAN_CODE'),
      name: requiredName(input.name, 'INVALID_PLAN_NAME'),
      durationSeconds: optionalDuration(input.durationSeconds, isPermanent),
      isPermanent,
      maxRegisteredDevices: integer(input.maxRegisteredDevices, 1, { minimum: 1 }),
      maxConcurrentDevices: integer(input.maxConcurrentDevices, 1, { minimum: 1 }),
      maxInstancesPerDevice: integer(input.maxInstancesPerDevice, 1, { minimum: 1 }),
      heartbeatRequired: input.heartbeatRequired !== false,
      heartbeatIntervalSeconds: integer(input.heartbeatIntervalSeconds, 60, { minimum: 1 }),
      leaseTtlSeconds: integer(input.leaseTtlSeconds, 180, { minimum: 1 }),
      offlineGraceSeconds: integer(input.offlineGraceSeconds, 0, { minimum: 0 }),
      deviceResetLimit: integer(input.deviceResetLimit, 0, { minimum: 0 }),
      deviceResetWindowDays: integer(input.deviceResetWindowDays, 30, { minimum: 1 }),
      concurrencyPolicy: status(input.concurrencyPolicy, CONCURRENCY_POLICIES, 'REJECT', 'INVALID_CONCURRENCY_POLICY'),
      features: plainFeatures(input.features),
      agentCostCredits: integer(input.agentCostCredits, 0, { minimum: 0 }),
      status: status(input.status, PLAN_STATUSES, 'ACTIVE', 'INVALID_PLAN_STATUS'),
    };
    const plan = await this.database.plan.create({ data });
    await this.audit?.record?.({
      ...context,
      action: 'PLAN_CREATED',
      targetType: 'PLAN',
      targetId: plan.id,
      before: null,
      after: serializePlan(plan),
    });
    return serializePlan(plan);
  }

  async listPlans(query = {}) {
    const where = {};
    if (query.productId) where.productId = String(query.productId);
    if (query.status) where.status = status(query.status, PLAN_STATUSES, 'ACTIVE', 'INVALID_PLAN_STATUS');
    const plans = await this.database.plan.findMany({ where, orderBy: { createdAt: 'desc' } });
    return { items: plans.map(serializePlan) };
  }

  async getPlan(id) {
    assertId(id, 'INVALID_PLAN_ID');
    const plan = await this.database.plan.findUnique({ where: { id } });
    if (!plan) throw new NotFoundException({ code: 'PLAN_NOT_FOUND' });
    return serializePlan(plan);
  }

  async updatePlan(id, changes = {}, context = {}) {
    assertId(id, 'INVALID_PLAN_ID');
    const before = await this.database.plan.findUnique({ where: { id } });
    if (!before) throw new NotFoundException({ code: 'PLAN_NOT_FOUND' });
    const data = {};
    if (changes.name !== undefined) data.name = requiredName(changes.name, 'INVALID_PLAN_NAME');
    if (changes.status !== undefined) data.status = status(changes.status, PLAN_STATUSES, before.status, 'INVALID_PLAN_STATUS');
    if (changes.features !== undefined) data.features = plainFeatures(changes.features);
    if (changes.agentCostCredits !== undefined) data.agentCostCredits = integer(changes.agentCostCredits, before.agentCostCredits, { minimum: 0 });
    if (changes.durationSeconds !== undefined) data.durationSeconds = optionalDuration(changes.durationSeconds, before.isPermanent);
    if (!Object.keys(data).length) bad('NO_PLAN_CHANGES');
    const plan = await this.database.plan.update({ where: { id }, data });
    await this.audit?.record?.({
      ...context,
      action: 'PLAN_UPDATED',
      targetType: 'PLAN',
      targetId: id,
      before: serializePlan(before),
      after: serializePlan(plan),
    });
    return serializePlan(plan);
  }
}

module.exports = {
  CatalogService,
  PRODUCT_STATUSES,
  PLAN_STATUSES,
  CONCURRENCY_POLICIES,
  serializeProduct,
  serializePlan,
};
