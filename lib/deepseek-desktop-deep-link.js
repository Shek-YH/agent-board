'use strict';

// DeepSeek Harness Desktop session IDs are opaque values. Keep the accepted
// alphabet narrow enough for a path segment while allowing future Unicode IDs.
const DEEPSEEK_SESSION_ID_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}_.:-]{0,199}$/u;

function isValidDeepSeekSessionId(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return false;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(sessionId)) return false;
  return DEEPSEEK_SESSION_ID_PATTERN.test(sessionId);
}

function buildDeepSeekDesktopDeepLink(sessionId) {
  if (!isValidDeepSeekSessionId(sessionId)) {
    throw new TypeError('无效的 DeepSeek sessionId');
  }
  return `dshdesktop://open/session/${encodeURIComponent(sessionId)}?source=agent-board`;
}

module.exports = { buildDeepSeekDesktopDeepLink, isValidDeepSeekSessionId };
