'use strict';

const FORBIDDEN_AUDIT_KEYS = /^(password|pass|access[_-]?token|refresh[_-]?token|token|cookie|device[_-]?private[_-]?key|private[_-]?key|database[_-]?(url|secret)|secret|code|redemption[_-]?code)$/i;
const AUDIT_SELECT = {
  id: true,
  actorType: true,
  actorId: true,
  action: true,
  targetType: true,
  targetId: true,
  beforeSanitized: true,
  afterSanitized: true,
  requestId: true,
  ip: true,
  userAgent: true,
  createdAt: true,
};

function sanitizeAuditValue(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(sanitizeAuditValue);
  if (value === null || typeof value !== 'object') return value;

  const sanitized = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    if (FORBIDDEN_AUDIT_KEYS.test(key)) continue;
    sanitized[key] = sanitizeAuditValue(nestedValue);
  }
  return sanitized;
}

function positiveInteger(value, fallback, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, maximum);
}

function normalizeAuditQuery(query = {}) {
  return {
    page: positiveInteger(query.page, 1, 1000000),
    pageSize: positiveInteger(query.pageSize, 20, 100),
    actorId: typeof query.actorId === 'string' ? query.actorId.trim() : '',
    action: typeof query.action === 'string' ? query.action.trim() : '',
    targetType: typeof query.targetType === 'string' ? query.targetType.trim() : '',
  };
}

function serializeAudit(record) {
  return {
    ...record,
    beforeSanitized: record.beforeSanitized == null ? null : sanitizeAuditValue(record.beforeSanitized),
    afterSanitized: record.afterSanitized == null ? null : sanitizeAuditValue(record.afterSanitized),
  };
}

function createAuditService(database) {
  return {
    record(input, transaction = database) {
      if (!input?.actorId || !input?.action || !input?.targetType) {
        throw new Error('Audit record requires actorId, action, and targetType');
      }

      return transaction.auditLog.create({
        data: {
          actorType: input.actorType || 'USER',
          actorId: input.actorId,
          action: input.action,
          targetType: input.targetType,
          targetId: input.targetId || null,
          beforeSanitized: input.before == null ? null : sanitizeAuditValue(input.before),
          afterSanitized: input.after == null ? null : sanitizeAuditValue(input.after),
          requestId: input.requestId || null,
          ip: input.ip || null,
          userAgent: input.userAgent || null,
        },
      });
    },

    async list(query) {
      const normalized = normalizeAuditQuery(query);
      const where = {};
      if (normalized.actorId) where.actorId = normalized.actorId;
      if (normalized.action) where.action = normalized.action;
      if (normalized.targetType) where.targetType = normalized.targetType;

      const [records, total] = await Promise.all([
        database.auditLog.findMany({
          where,
          select: AUDIT_SELECT,
          orderBy: { createdAt: 'desc' },
          skip: (normalized.page - 1) * normalized.pageSize,
          take: normalized.pageSize,
        }),
        database.auditLog.count({ where }),
      ]);

      return {
        items: records.map(serializeAudit),
        meta: { page: normalized.page, pageSize: normalized.pageSize, total },
      };
    },
  };
}

module.exports = { createAuditService, sanitizeAuditValue };
