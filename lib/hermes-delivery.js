'use strict';

const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const hermes = require('./adapters/hermes');

function normalizeText(value) {
  return String(value == null ? '' : value).replace(/\r\n/g, '\n').trim();
}

function targetSessionId(target) {
  if (!target || typeof target !== 'object') return null;
  const explicit = target.sessionId || target.hermesSessionId;
  if (explicit) return String(explicit);
  const ref = String(target.sessionRef || '');
  return ref.startsWith('hermes:') ? ref.slice('hermes:'.length) : (ref || null);
}

function failure(code, reason, extra = {}) {
  return { ok: false, delivered: false, code, reason, ...extra };
}

function textFingerprint(value) {
  return crypto.createHash('sha256').update(String(value == null ? '' : value).trim(), 'utf8').digest('hex');
}

function codedError(code, reason) {
  const error = new Error(reason);
  error.code = code;
  return error;
}

function extractText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(extractText).filter(Boolean).join('\n');
  if (value && typeof value === 'object') {
    if (typeof value.text === 'string') return value.text;
    if (typeof value.content !== 'undefined') return extractText(value.content);
  }
  return '';
}

function openReadOnly(dbPath, DatabaseSyncImpl = DatabaseSync) {
  if (!dbPath) throw codedError('DELIVERY_UNKNOWN', 'Hermes state database path is missing');
  return new DatabaseSyncImpl(dbPath, { readOnly: true });
}

function captureHermesDeliverySnapshot(target, options = {}) {
  const sessionId = targetSessionId(target);
  if (!sessionId) throw codedError('TARGET_ANCHOR_MISSING', 'Hermes target does not contain a session ID');
  const dbPath = options.dbPath || target.dbPath || hermes.DB;
  let db;
  try {
    db = openReadOnly(dbPath, options.DatabaseSync);
    const session = db.prepare('SELECT id FROM sessions WHERE id = ?').get(sessionId);
    if (!session) throw codedError('SESSION_NOT_FOUND', 'Hermes target session does not exist');
    const latest = db.prepare('SELECT COALESCE(MAX(id), -1) AS lastMessageId FROM messages WHERE session_id = ?').get(sessionId);
    return {
      agent: 'hermes',
      sessionRef: String(target.sessionRef || ''),
      sessionId,
      dbPath,
      lastMessageId: Number(latest && latest.lastMessageId),
      capturedAt: Number.isFinite(options.now) ? options.now : Date.now(),
    };
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

function verifyHermesDelivery(target, expectedMessage, context = {}, options = {}) {
  const expected = normalizeText(expectedMessage);
  if (!expected) return failure('EMPTY_MESSAGE', '消息不能为空');
  const snapshot = context.snapshot;
  if (!snapshot || snapshot.agent !== 'hermes' || !snapshot.dbPath
    || !Number.isInteger(snapshot.lastMessageId) || snapshot.lastMessageId < -1) {
    return failure('DELIVERY_SNAPSHOT_MISSING', '缺少 Hermes 发送前数据库快照', { unknown: true });
  }
  const sessionId = targetSessionId(target);
  if (!sessionId || snapshot.sessionId !== sessionId) {
    return failure('SESSION_DB_MISMATCH', 'Hermes delivery snapshot 与目标 session 不一致');
  }
  let db;
  try {
    db = openReadOnly(snapshot.dbPath, options.DatabaseSync);
    const session = db.prepare('SELECT id FROM sessions WHERE id = ?').get(sessionId);
    if (!session) return failure('SESSION_NOT_FOUND', 'Hermes target session no longer exists');
    const rows = db.prepare(
      'SELECT id, session_id, role, content, timestamp FROM messages WHERE session_id = ? AND id > ? ORDER BY id',
    ).all(sessionId, snapshot.lastMessageId);
    const boundary = Number(context.sentAt || snapshot.capturedAt || 0);
    for (const row of rows) {
      if (row.session_id !== sessionId || row.role !== 'user') continue;
      const timestamp = hermes.normalizeTimestamp(row.timestamp);
      if (!timestamp || timestamp < boundary) continue;
      if (normalizeText(extractText(row.content)) !== expected) continue;
      return {
        ok: true,
        delivered: true,
        agent: 'hermes',
        sessionRef: String(target.sessionRef || ''),
        sessionId,
        messageId: Number(row.id),
        timestamp,
        textLength: expected.length,
        lastMessageId: snapshot.lastMessageId,
      };
    }
    return failure('DELIVERY_NOT_FOUND', '发送后未找到目标 Hermes session 的新 user message', {
      lastMessageId: snapshot.lastMessageId,
    });
  } catch (error) {
    return failure('DELIVERY_UNKNOWN', 'Unable to read Hermes delivery evidence: ' + error.message, { unknown: true });
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

function verifyHermesDeliveryFingerprint(target, expectedFingerprint, context = {}, options = {}) {
  const expected = String(expectedFingerprint || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expected)) return failure('INSTRUCTION_FINGERPRINT_MISSING', '缺少有效的指令指纹');
  const snapshot = context.snapshot;
  if (!snapshot || snapshot.agent !== 'hermes' || !snapshot.dbPath
    || !Number.isInteger(snapshot.lastMessageId) || snapshot.lastMessageId < -1) {
    return failure('DELIVERY_SNAPSHOT_MISSING', '缺少 Hermes 发送前数据库快照', { unknown: true });
  }
  const sessionId = targetSessionId(target);
  if (!sessionId || snapshot.sessionId !== sessionId) {
    return failure('SESSION_DB_MISMATCH', 'Hermes delivery snapshot 与目标 session 不一致');
  }
  let db;
  try {
    db = openReadOnly(snapshot.dbPath, options.DatabaseSync);
    const session = db.prepare('SELECT id FROM sessions WHERE id = ?').get(sessionId);
    if (!session) return failure('SESSION_NOT_FOUND', 'Hermes target session no longer exists');
    const rows = db.prepare(
      'SELECT id, session_id, role, content, timestamp FROM messages WHERE session_id = ? AND id > ? ORDER BY id',
    ).all(sessionId, snapshot.lastMessageId);
    const boundary = Number(context.sentAt || snapshot.capturedAt || 0);
    for (const row of rows) {
      if (row.session_id !== sessionId || row.role !== 'user') continue;
      const timestamp = hermes.normalizeTimestamp(row.timestamp);
      if (!timestamp || timestamp < boundary) continue;
      const message = normalizeText(extractText(row.content));
      if (textFingerprint(message) !== expected) continue;
      return {
        ok: true,
        delivered: true,
        agent: 'hermes',
        sessionRef: String(target.sessionRef || ''),
        sessionId,
        messageId: Number(row.id),
        timestamp,
        textLength: message.length,
        fingerprintVerified: true,
        lastMessageId: snapshot.lastMessageId,
      };
    }
    return failure('DELIVERY_NOT_FOUND', '发送后未找到目标 Hermes session 的新 user message', {
      lastMessageId: snapshot.lastMessageId,
    });
  } catch (error) {
    return failure('DELIVERY_UNKNOWN', 'Unable to read Hermes delivery evidence: ' + error.message, { unknown: true });
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

function createHermesDeliveryReader(options = {}) {
  return {
    snapshot(target, context = {}) {
      return captureHermesDeliverySnapshot(target, { ...options, ...context });
    },
    verify(target, expectedMessage, context = {}) {
      return verifyHermesDelivery(target, expectedMessage, context, options);
    },
    verifyFingerprint(target, expectedFingerprint, context = {}) {
      return verifyHermesDeliveryFingerprint(target, expectedFingerprint, context, options);
    },
  };
}

module.exports = {
  normalizeText,
  targetSessionId,
  extractText,
  captureHermesDeliverySnapshot,
  verifyHermesDelivery,
  verifyHermesDeliveryFingerprint,
  createHermesDeliveryReader,
};
