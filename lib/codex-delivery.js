'use strict';

const fs = require('fs');
const crypto = require('crypto');
const { collectFiles } = require('./watcher');
const codex = require('./adapters/codex');
const { extractCodexThreadId, isValidCodexThreadId } = require('./codex-deep-link');

function normalizeText(value) {
  return String(value == null ? '' : value).replace(/\r\n/g, '\n').trim();
}

function normalizeCodexDeliveryText(value) {
  return normalizeText(value).replace(/\\_/g, '_');
}

function targetThreadId(target) {
  if (!target || typeof target !== 'object') return null;
  const explicit = target.threadId || target.codexThreadId;
  if (explicit && isValidCodexThreadId(String(explicit))) return String(explicit);
  const extracted = extractCodexThreadId(String(target.sessionRef || ''));
  return extracted && isValidCodexThreadId(extracted) ? extracted : null;
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

function resolveSourceFile(target, options = {}) {
  const threadId = targetThreadId(target);
  if (!threadId) throw codedError('TARGET_ANCHOR_MISSING', 'Codex target does not contain a valid thread ID');
  const direct = options.filePath || target.sourcePath || target.filePath;
  if (direct) {
    const fileThreadId = extractCodexThreadId(codex.fileToSessionId(direct));
    if (fileThreadId !== threadId) {
      throw codedError('SESSION_FILE_MISMATCH', 'Codex source file does not match the target thread');
    }
    return direct;
  }
  const root = options.root || codex.ROOT;
  const candidates = collectFiles(root, codex.isSessionFile)
    .filter((filePath) => extractCodexThreadId(codex.fileToSessionId(filePath)) === threadId);
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) throw codedError('SESSION_FILE_AMBIGUOUS', 'Multiple Codex source files match the target thread');
  throw codedError('SESSION_FILE_NOT_FOUND', 'No Codex source file matches the target thread');
}

function captureCodexDeliverySnapshot(target, options = {}) {
  const filePath = resolveSourceFile(target, options);
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (error) {
    throw codedError('DELIVERY_UNKNOWN', 'Unable to stat Codex source file: ' + error.message);
  }
  return {
    agent: 'codex',
    sessionRef: String(target.sessionRef || ''),
    threadId: targetThreadId(target),
    filePath,
    byteOffset: stat.size,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    capturedAt: Number.isFinite(options.now) ? options.now : Date.now(),
  };
}

function parseAppendedUserEvents(filePath, buffer) {
  const text = buffer.toString('utf8');
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  const parsed = [];
  let malformed = 0;
  for (const line of lines) {
    try {
      parsed.push(JSON.parse(line));
    } catch {
      malformed++;
    }
  }
  return {
    malformed,
    events: codex.parseLines(parsed, filePath)
      .filter((event) => event.kind === 'message' && event.role === 'user'),
  };
}

function verifyCodexDelivery(target, expectedMessage, context = {}, options = {}) {
  const expected = normalizeText(expectedMessage);
  if (!expected) return failure('EMPTY_MESSAGE', '消息不能为空');
  const snapshot = context.snapshot;
  if (!snapshot || snapshot.agent !== 'codex' || !snapshot.filePath
    || !Number.isInteger(snapshot.byteOffset) || snapshot.byteOffset < 0) {
    return failure('DELIVERY_SNAPSHOT_MISSING', '缺少 Codex 发送前文件快照', { unknown: true });
  }
  const threadId = targetThreadId(target);
  if (!threadId || snapshot.threadId !== threadId) {
    return failure('SESSION_FILE_MISMATCH', 'Codex delivery snapshot 与目标 thread 不一致');
  }
  let stat;
  let appended;
  try {
    stat = fs.statSync(snapshot.filePath);
    if (stat.size < snapshot.byteOffset) {
      return failure('DELIVERY_UNKNOWN', 'Codex source file was truncated after snapshot', { unknown: true });
    }
    const full = fs.readFileSync(snapshot.filePath);
    appended = parseAppendedUserEvents(snapshot.filePath, full.subarray(snapshot.byteOffset));
  } catch (error) {
    return failure('DELIVERY_UNKNOWN', 'Unable to read Codex delivery evidence: ' + error.message, { unknown: true });
  }
  const boundary = Number(context.sentAt || snapshot.capturedAt || 0);
  for (const event of appended.events) {
    if (event.sessionId && extractCodexThreadId(event.sessionId) !== threadId) continue;
    if (!event.ts || event.ts < boundary) continue;
    const observedText = normalizeText(event.text);
    const deliveryText = normalizeCodexDeliveryText(event.text);
    if (observedText !== expected && deliveryText !== expected) continue;
    return {
      ok: true,
      delivered: true,
      agent: 'codex',
      sessionRef: String(target.sessionRef || ''),
      threadId,
      filePath: snapshot.filePath,
      sourceId: event.sourceId,
      timestamp: event.ts,
      textLength: expected.length,
      transportNormalized: deliveryText !== observedText,
      byteOffset: snapshot.byteOffset,
    };
  }
  return failure('DELIVERY_NOT_FOUND', '发送后未找到目标 Codex session 的新 user message', {
    malformedRows: appended.malformed,
    byteOffset: snapshot.byteOffset,
  });
}

function verifyCodexDeliveryFingerprint(target, expectedFingerprint, context = {}, options = {}) {
  const expected = String(expectedFingerprint || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expected)) return failure('INSTRUCTION_FINGERPRINT_MISSING', '缺少有效的指令指纹');
  const snapshot = context.snapshot;
  if (!snapshot || snapshot.agent !== 'codex' || !snapshot.filePath
    || !Number.isInteger(snapshot.byteOffset) || snapshot.byteOffset < 0) {
    return failure('DELIVERY_SNAPSHOT_MISSING', '缺少 Codex 发送前文件快照', { unknown: true });
  }
  const threadId = targetThreadId(target);
  if (!threadId || snapshot.threadId !== threadId) {
    return failure('SESSION_FILE_MISMATCH', 'Codex delivery snapshot 与目标 thread 不一致');
  }
  let stat;
  let appended;
  try {
    stat = fs.statSync(snapshot.filePath);
    if (stat.size < snapshot.byteOffset) {
      return failure('DELIVERY_UNKNOWN', 'Codex source file was truncated after snapshot', { unknown: true });
    }
    const full = fs.readFileSync(snapshot.filePath);
    appended = parseAppendedUserEvents(snapshot.filePath, full.subarray(snapshot.byteOffset));
  } catch (error) {
    return failure('DELIVERY_UNKNOWN', 'Unable to read Codex delivery evidence: ' + error.message, { unknown: true });
  }
  const boundary = Number(context.sentAt || snapshot.capturedAt || 0);
  for (const event of appended.events) {
    if (event.sessionId && extractCodexThreadId(event.sessionId) !== threadId) continue;
    if (!event.ts || event.ts < boundary) continue;
    const observedText = normalizeText(event.text);
    const deliveryText = normalizeCodexDeliveryText(event.text);
    if (textFingerprint(observedText) !== expected && textFingerprint(deliveryText) !== expected) continue;
    return {
      ok: true,
      delivered: true,
      agent: 'codex',
      sessionRef: String(target.sessionRef || ''),
      threadId,
      filePath: snapshot.filePath,
      sourceId: event.sourceId,
      timestamp: event.ts,
      textLength: observedText.length,
      fingerprintVerified: true,
      byteOffset: snapshot.byteOffset,
    };
  }
  return failure('DELIVERY_NOT_FOUND', '发送后未找到目标 Codex session 的新 user message', {
    malformedRows: appended.malformed,
    byteOffset: snapshot.byteOffset,
  });
}

function createCodexDeliveryReader(options = {}) {
  return {
    snapshot(target, context = {}) {
      return captureCodexDeliverySnapshot(target, { ...options, ...context });
    },
    verify(target, expectedMessage, context = {}) {
      return verifyCodexDelivery(target, expectedMessage, context, options);
    },
    verifyFingerprint(target, expectedFingerprint, context = {}) {
      return verifyCodexDeliveryFingerprint(target, expectedFingerprint, context, options);
    },
  };
}

module.exports = {
  normalizeText,
  normalizeCodexDeliveryText,
  targetThreadId,
  resolveSourceFile,
  captureCodexDeliverySnapshot,
  verifyCodexDelivery,
  verifyCodexDeliveryFingerprint,
  createCodexDeliveryReader,
};
