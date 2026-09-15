'use strict';

const HERMES_SESSION_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,160}$/;

function isValidHermesSessionId(sessionId) {
  return typeof sessionId === 'string' && HERMES_SESSION_ID_PATTERN.test(sessionId);
}

// Hermes Desktop 的会话路由是单段 `/<storedSessionId>`；`session` 不是它的保留 host，
// 会被当作插件命名空间解析成 `/session/<id>`（桌面端 routeSessionId 认不出，跳转静默失效）。
// `open` 才是桌面端约定的「应用内路径」host：`hermes://open/<id>` → 路由 `/<id>`。
function buildHermesDesktopDeepLink(sessionId) {
  if (!isValidHermesSessionId(sessionId)) {
    throw new TypeError('无效的 Hermes sessionId');
  }
  return `hermes://open/${encodeURIComponent(sessionId)}`;
}

module.exports = { buildHermesDesktopDeepLink, isValidHermesSessionId };
