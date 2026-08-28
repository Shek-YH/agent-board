'use strict';

const { BadRequestException, NotFoundException } = require('@nestjs/common');

const EVENT_SEVERITIES = new Set(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
const EVENT_STATUSES = new Set(['OPEN', 'RESOLVED']);
const PAGE_MAX = 100;
const SENSITIVE_METADATA_KEY = /(password|token|secret|private|credential|cookie|authorization|api[_-]?key|redemption[_-]?code|\bcode\b|body)/i;

function bad(code) {
  throw new BadRequestException({ code });
}

function requiredText(value, code, maximum = 120) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximum) bad(code);
  return value.trim();
}

function optionalText(value, code, maximum = 255) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.trim().length > maximum) bad(code);
  return value.trim();
}

function positiveInteger(value, fallback, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, maximum);
}

function sanitizeSecurityMetadata(value, depth = 0) {
  if (value instanceof Date) return value.toISOString();
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'string') return value.slice(0, 512);
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    return null;
  }
  if (depth >= 4) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitizeSecurityMetadata(item, depth + 1));

  const output = {};
  for (const [key, nestedValue] of Object.entries(value).slice(0, 50)) {
    if (SENSITIVE_METADATA_KEY.test(key)) continue;
    output[key.slice(0, 120)] = sanitizeSecurityMetadata(nestedValue, depth + 1);
  }
  return output;
}

function serializeSecurityEvent(event) {
  if (!event) return null;
  return {
    id: event.id,
    userId: event.userId,
    deviceId: event.deviceId,
    agentId: event.agentId,
    type: event.type,
    severity: event.severity,
    ip: event.ip,
    metadataSanitized: sanitizeSecurityMetadata(event.metadataSanitized || {}),
    status: event.status,
    createdAt: event.createdAt,
    resolvedAt: event.resolvedAt,
    resolvedBy: event.resolvedBy,
  };
}

class SecurityEventService {
  constructor(database, audit, clock = () => new Date()) {
    this.database = database;
    this.audit = audit;
    this.clock = clock;
  }

  async create(input = {}, transaction = this.database) {
    const type = requiredText(input.type, 'INVALID_SECURITY_EVENT_TYPE');
    const severity = String(input.severity || 'MEDIUM').toUpperCase();
    if (!EVENT_SEVERITIES.has(severity)) bad('INVALID_SECURITY_EVENT_SEVERITY');
    const status = String(input.status || 'OPEN').toUpperCase();
    if (!EVENT_STATUSES.has(status)) bad('INVALID_SECURITY_EVENT_STATUS');
    const event = await transaction.securityEvent.create({
      data: {
        userId: optionalText(input.userId, 'INVALID_USER_ID'),
        deviceId: optionalText(input.deviceId, 'INVALID_DEVICE_ID'),
        agentId: optionalText(input.agentId, 'INVALID_AGENT_ID'),
        type,
        severity,
        ip: optionalText(input.ip, 'INVALID_SECURITY_EVENT_IP', 128),
        metadataSanitized: sanitizeSecurityMetadata(input.metadataSanitized || input.metadata || {}),
        status,
        createdAt: input.createdAt ? new Date(input.createdAt) : this.clock(),
      },
    });
    return serializeSecurityEvent(event);
  }

  async list(query = {}) {
    const page = positiveInteger(query.page, 1, 1000000);
    const pageSize = positiveInteger(query.pageSize, 20, PAGE_MAX);
    const where = {};
    for (const [field, code] of [['userId', 'INVALID_USER_ID'], ['deviceId', 'INVALID_DEVICE_ID'], ['agentId', 'INVALID_AGENT_ID']]) {
      if (query[field]) where[field] = optionalText(query[field], code);
    }
    if (query.type) where.type = requiredText(query.type, 'INVALID_SECURITY_EVENT_TYPE');
    if (query.severity) {
      where.severity = String(query.severity).toUpperCase();
      if (!EVENT_SEVERITIES.has(where.severity)) bad('INVALID_SECURITY_EVENT_SEVERITY');
    }
    if (query.status) {
      where.status = String(query.status).toUpperCase();
      if (!EVENT_STATUSES.has(where.status)) bad('INVALID_SECURITY_EVENT_STATUS');
    }
    const [events, total] = await Promise.all([
      this.database.securityEvent.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
      this.database.securityEvent.count({ where }),
    ]);
    return { items: events.map(serializeSecurityEvent), meta: { page, pageSize, total } };
  }

  async resolve(id, context = {}) {
    const eventId = requiredText(id, 'INVALID_SECURITY_EVENT_ID');
    const actorId = requiredText(context.actorId, 'INVALID_ACTOR_ID');
    const before = await this.database.securityEvent.findUnique({ where: { id: eventId } });
    if (!before) throw new NotFoundException({ code: 'SECURITY_EVENT_NOT_FOUND' });
    if (before.status === 'RESOLVED') return serializeSecurityEvent(before);
    const resolvedAt = this.clock();
    const event = await this.database.securityEvent.update({
      where: { id: eventId },
      data: { status: 'RESOLVED', resolvedAt, resolvedBy: actorId },
    });
    await this.audit?.record?.({
      ...context,
      actorType: context.actorType || 'USER',
      actorId,
      action: 'SECURITY_EVENT_RESOLVED',
      targetType: 'SECURITY_EVENT',
      targetId: eventId,
      before: { status: before.status, type: before.type, severity: before.severity },
      after: { status: event.status, resolvedAt },
    });
    return serializeSecurityEvent(event);
  }
}

module.exports = {
  EVENT_SEVERITIES,
  EVENT_STATUSES,
  SecurityEventService,
  sanitizeSecurityMetadata,
  serializeSecurityEvent,
};

function createSecurityEventService(database, audit, clock) {
  return new SecurityEventService(database, audit, clock);
}

module.exports.createSecurityEventService = createSecurityEventService;
