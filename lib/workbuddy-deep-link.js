'use strict';

// WorkBuddy 当前桌面端把 `workbuddy://chat/<conversationId>` 作为打开已有
// 会话的深链。conversationId 与 ~/.workbuddy/projects 下 JSONL 文件名相同。
const WORKBUDDY_SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidWorkBuddySessionId(sessionId) {
  return typeof sessionId === 'string' && WORKBUDDY_SESSION_ID_PATTERN.test(sessionId);
}

function buildWorkBuddyDeepLink(sessionId) {
  if (!isValidWorkBuddySessionId(sessionId)) {
    throw new TypeError('无效的 WorkBuddy sessionId');
  }
  return `workbuddy://chat/${encodeURIComponent(sessionId)}`;
}

module.exports = { buildWorkBuddyDeepLink, isValidWorkBuddySessionId };
