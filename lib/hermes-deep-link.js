'use strict';

const HERMES_SESSION_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,160}$/;

function isValidHermesSessionId(sessionId) {
  return typeof sessionId === 'string' && HERMES_SESSION_ID_PATTERN.test(sessionId);
}

function buildHermesDesktopDeepLink(sessionId) {
  if (!isValidHermesSessionId(sessionId)) {
    throw new TypeError('无效的 Hermes sessionId');
  }
  return `hermes://session/${encodeURIComponent(sessionId)}`;
}

module.exports = { buildHermesDesktopDeepLink, isValidHermesSessionId };
