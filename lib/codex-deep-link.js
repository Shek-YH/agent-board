'use strict';

const CODEX_THREAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function extractCodexThreadId(sessionId) {
  if (typeof sessionId !== 'string') return null;
  const match = sessionId.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  return match ? match[1] : null;
}

function isValidCodexThreadId(threadId) {
  return typeof threadId === 'string' && CODEX_THREAD_ID_PATTERN.test(threadId);
}

function buildCodexDeepLink(threadId) {
  if (!isValidCodexThreadId(threadId)) {
    throw new TypeError('无效的 Codex threadId');
  }
  return `codex://threads/${threadId}`;
}

module.exports = { buildCodexDeepLink, extractCodexThreadId, isValidCodexThreadId };
