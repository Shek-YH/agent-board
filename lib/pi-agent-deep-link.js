'use strict';

// Pi Agent Desktop session IDs come from the JSONL session header. Keep the
// accepted alphabet narrow enough that a value cannot inject another URL or
// path segment into the deep link.
const PI_SESSION_ID_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}_.-]{0,199}$/u;

function isValidPiAgentSessionId(sessionId) {
  return typeof sessionId === 'string' && PI_SESSION_ID_PATTERN.test(sessionId);
}

function buildPiAgentDesktopDeepLink(sessionId) {
  if (!isValidPiAgentSessionId(sessionId)) {
    throw new TypeError('无效的 Pi Agent sessionId');
  }
  return `piagent://open/session/${encodeURIComponent(sessionId)}?source=agent-board`;
}

module.exports = { buildPiAgentDesktopDeepLink, isValidPiAgentSessionId };
