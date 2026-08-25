'use strict';

// Marvis 当前桌面端通过 conversation.share 伪协议命令打开已有对话。
// conversation_id 来自 Marvis 数据库，不允许把任意路径或协议片段拼进深链。
const MARVIS_SESSION_ID_PATTERN = /^conv_[A-Za-z0-9_-]{1,160}$/;

function isValidMarvisSessionId(sessionId) {
  return typeof sessionId === 'string' && MARVIS_SESSION_ID_PATTERN.test(sessionId);
}

function buildMarvisDeepLink(sessionId) {
  if (!isValidMarvisSessionId(sessionId)) {
    throw new TypeError('无效的 Marvis sessionId');
  }
  return `marvis://conversation/share?id=${encodeURIComponent(sessionId)}`;
}

module.exports = { buildMarvisDeepLink, isValidMarvisSessionId };
