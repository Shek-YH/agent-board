'use strict';

const { BadRequestException, NotFoundException } = require('@nestjs/common');

const POLICY_STATUSES = new Set(['ACTIVE', 'DISABLED']);

function bad(code) {
  throw new BadRequestException({ code });
}

function assertId(value, code) {
  if (typeof value !== 'string' || !value.trim()) bad(code);
  return value.trim();
}

function parseVersion(value) {
  if (typeof value !== 'string' || !value.trim()) bad('INVALID_CLIENT_VERSION');
  const normalized = value.trim().replace(/^v/i, '');
  const [buildless, build] = normalized.split('+', 2);
  const [core, prerelease] = buildless.split('-', 2);
  const parts = core.split('.');
  if (parts.length > 3 || parts.some((part) => !/^\d+$/.test(part))) bad('INVALID_CLIENT_VERSION');
  const numbers = parts.map((part) => Number(part));
  if (numbers.some((part) => !Number.isSafeInteger(part) || part < 0)) bad('INVALID_CLIENT_VERSION');
  const prereleaseParts = prerelease ? prerelease.split('.') : [];
  if (prereleaseParts.some((part) => !/^[0-9A-Za-z-]+$/.test(part))) bad('INVALID_CLIENT_VERSION');
  return { numbers: [...numbers, 0, 0].slice(0, 3), prereleaseParts, build };
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] > b.numbers[index] ? 1 : -1;
  }
  if (!a.prereleaseParts.length && !b.prereleaseParts.length) return 0;
  if (!a.prereleaseParts.length) return 1;
  if (!b.prereleaseParts.length) return -1;
  const length = Math.max(a.prereleaseParts.length, b.prereleaseParts.length);
  for (let index = 0; index < length; index += 1) {
    if (index >= a.prereleaseParts.length) return -1;
    if (index >= b.prereleaseParts.length) return 1;
    const leftPart = a.prereleaseParts[index];
    const rightPart = b.prereleaseParts[index];
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return Number(leftPart) > Number(rightPart) ? 1 : -1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart > rightPart ? 1 : -1;
  }
  return 0;
}

function normalizeVersion(value) {
  const parsed = parseVersion(value);
  const core = parsed.numbers.join('.');
  return parsed.prereleaseParts.length ? `${core}-${parsed.prereleaseParts.join('.')}` : core;
}

function evaluateClientVersion(appVersion, policy) {
  const current = normalizeVersion(appVersion);
  if (!policy || policy.status !== 'ACTIVE') return { status: 'SUPPORTED', policy: null };
  const required = policy.minimumVersion && compareVersions(current, policy.minimumVersion) < 0;
  const forced = policy.forceUpgradeBelow && compareVersions(current, policy.forceUpgradeBelow) < 0;
  const status = required || forced
    ? 'UPDATE_REQUIRED'
    : policy.latestVersion && compareVersions(current, policy.latestVersion) < 0
      ? 'UPDATE_AVAILABLE'
      : 'SUPPORTED';
  return {
    status,
    policy: {
      id: policy.id,
      productId: policy.productId,
      latestVersion: policy.latestVersion,
      minimumVersion: policy.minimumVersion,
      forceUpgradeBelow: policy.forceUpgradeBelow,
      downloadUrl: policy.downloadUrl,
      message: policy.message,
      status: policy.status,
      updatedAt: policy.updatedAt,
    },
  };
}

function serializePolicy(policy) {
  if (!policy) return null;
  return {
    id: policy.id,
    productId: policy.productId,
    latestVersion: policy.latestVersion,
    minimumVersion: policy.minimumVersion,
    forceUpgradeBelow: policy.forceUpgradeBelow,
    downloadUrl: policy.downloadUrl,
    message: policy.message,
    status: policy.status,
    createdAt: policy.createdAt,
    updatedAt: policy.updatedAt,
  };
}

function optionalText(value, code, maximum) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.trim().length > maximum) bad(code);
  return value.trim();
}

function optionalUrl(value) {
  const normalized = optionalText(value, 'INVALID_VERSION_DOWNLOAD_URL', 2048);
  if (!normalized) return null;
  try {
    const url = new URL(normalized);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
  } catch {
    bad('INVALID_VERSION_DOWNLOAD_URL');
  }
  return normalized;
}

class ClientVersionPolicyService {
  constructor(database, audit) {
    this.database = database;
    this.audit = audit;
  }

  async create(input = {}, context = {}) {
    const productId = assertId(input.productId, 'INVALID_PRODUCT_ID');
    const product = await this.database.product.findUnique({ where: { id: productId } });
    if (!product) throw new NotFoundException({ code: 'PRODUCT_NOT_FOUND' });
    if (product.status !== 'ACTIVE') bad('PRODUCT_DISABLED');
    const existing = await this.database.clientVersionPolicy.findUnique({ where: { productId } });
    if (existing) bad('VERSION_POLICY_EXISTS');
    const data = this.normalize(input, productId);
    const policy = await this.database.clientVersionPolicy.create({ data });
    await this.audit?.record?.({ ...context, action: 'CLIENT_VERSION_POLICY_CREATED', targetType: 'CLIENT_VERSION_POLICY', targetId: policy.id, before: null, after: serializePolicy(policy) });
    return serializePolicy(policy);
  }

  async list(query = {}) {
    const where = {};
    if (query.productId) where.productId = assertId(query.productId, 'INVALID_PRODUCT_ID');
    if (query.status) {
      const status = String(query.status).toUpperCase();
      if (!POLICY_STATUSES.has(status)) bad('INVALID_VERSION_POLICY_STATUS');
      where.status = status;
    }
    const policies = await this.database.clientVersionPolicy.findMany({ where, orderBy: { updatedAt: 'desc' } });
    return { items: policies.map(serializePolicy) };
  }

  async getById(id) {
    const policyId = assertId(id, 'INVALID_VERSION_POLICY_ID');
    const policy = await this.database.clientVersionPolicy.findUnique({ where: { id: policyId } });
    if (!policy) throw new NotFoundException({ code: 'VERSION_POLICY_NOT_FOUND' });
    return serializePolicy(policy);
  }

  async update(id, changes = {}, context = {}) {
    const policyId = assertId(id, 'INVALID_VERSION_POLICY_ID');
    const before = await this.database.clientVersionPolicy.findUnique({ where: { id: policyId } });
    if (!before) throw new NotFoundException({ code: 'VERSION_POLICY_NOT_FOUND' });
    const data = this.normalize({ ...before, ...changes }, before.productId, true);
    const policy = await this.database.clientVersionPolicy.update({ where: { id: policyId }, data });
    await this.audit?.record?.({ ...context, action: 'CLIENT_VERSION_POLICY_UPDATED', targetType: 'CLIENT_VERSION_POLICY', targetId: policy.id, before: serializePolicy(before), after: serializePolicy(policy) });
    return serializePolicy(policy);
  }

  async getActive(productId, transaction = this.database) {
    const id = assertId(productId, 'INVALID_PRODUCT_ID');
    return transaction.clientVersionPolicy.findUnique({ where: { productId: id } }).then((policy) => policy?.status === 'ACTIVE' ? policy : null);
  }

  normalize(input, productId, isUpdate = false) {
    const latestVersion = normalizeVersion(input.latestVersion);
    const minimumVersion = normalizeVersion(input.minimumVersion);
    if (compareVersions(latestVersion, minimumVersion) < 0) bad('INVALID_VERSION_POLICY_RANGE');
    const forceUpgradeBelow = input.forceUpgradeBelow === undefined
      ? null
      : input.forceUpgradeBelow === null || input.forceUpgradeBelow === ''
        ? null
        : normalizeVersion(input.forceUpgradeBelow);
    if (forceUpgradeBelow && compareVersions(forceUpgradeBelow, latestVersion) > 0) bad('INVALID_VERSION_POLICY_RANGE');
    const status = input.status === undefined || input.status === null || input.status === ''
      ? 'ACTIVE'
      : String(input.status).toUpperCase();
    if (!POLICY_STATUSES.has(status)) bad('INVALID_VERSION_POLICY_STATUS');
    if (isUpdate && input.productId && input.productId !== productId) bad('VERSION_POLICY_PRODUCT_IMMUTABLE');
    return {
      productId,
      latestVersion,
      minimumVersion,
      forceUpgradeBelow,
      downloadUrl: optionalUrl(input.downloadUrl),
      message: optionalText(input.message, 'INVALID_VERSION_POLICY_MESSAGE', 1000),
      status,
    };
  }
}

module.exports = {
  ClientVersionPolicyService,
  POLICY_STATUSES,
  compareVersions,
  evaluateClientVersion,
  normalizeVersion,
  serializePolicy,
};
