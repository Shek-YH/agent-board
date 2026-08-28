'use strict';

(function attachSessionCardStacking(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && typeof root === 'object') root.AgentBoardSessionStacking = api;
}(typeof window !== 'undefined' ? window : typeof globalThis !== 'undefined' ? globalThis : this, function createSessionCardStacking() {
  const SUBAGENT_CARD_STYLE_KEY = 'ab-subagent-card-style';

  function normalizeSubagentCardStyle(value) {
    return value === 'stacked' ? 'stacked' : 'flat';
  }

  function loadSubagentCardStyle(storage) {
    try {
      if (!storage || typeof storage.getItem !== 'function') return 'flat';
      return normalizeSubagentCardStyle(storage.getItem(SUBAGENT_CARD_STYLE_KEY));
    } catch {
      return 'flat';
    }
  }

  function saveSubagentCardStyle(storage, value) {
    const style = normalizeSubagentCardStyle(value);
    try {
      if (storage && typeof storage.setItem === 'function') {
        storage.setItem(SUBAGENT_CARD_STYLE_KEY, style);
      }
    } catch {
      // 存储不可用时保持内存中的规范化结果，不把异常泄漏给调用方。
    }
    return style;
  }

  function findVisibleRoot(session, byId) {
    if (!session || typeof session !== 'object' || session.session_role !== 'child') return null;
    const visited = new Set();
    let current = session;
    while (current && current.session_role === 'child' && current.parent_session_ref) {
      if (visited.has(current)) return null;
      visited.add(current);
      const parent = byId.get(current.parent_session_ref);
      if (!parent) return null;
      if (parent.session_role === 'main') return parent;
      if (parent.session_role !== 'child') return null;
      current = parent;
    }
    return null;
  }

  function groupSessions(list) {
    const sessions = Array.isArray(list) ? list : [];
    const byId = new Map();
    for (const session of sessions) {
      if (!session || typeof session !== 'object') continue;
      if (session.id != null && !byId.has(session.id)) byId.set(session.id, session);
    }

    const rootByChild = new Map();
    const childrenByRoot = new Map();
    for (const session of sessions) {
      const root = findVisibleRoot(session, byId);
      if (!root) continue;
      rootByChild.set(session, root);
      const children = childrenByRoot.get(root) || [];
      children.push(session);
      childrenByRoot.set(root, children);
    }

    const result = [];
    for (const session of sessions) {
      const children = childrenByRoot.get(session);
      if (children) {
        result.push({ type: 'group', root: session, children });
      } else if (!rootByChild.has(session)) {
        result.push({ type: 'session', session });
      }
    }
    return result;
  }

  return {
    SUBAGENT_CARD_STYLE_KEY,
    normalizeSubagentCardStyle,
    loadSubagentCardStyle,
    saveSubagentCardStyle,
    groupSessions,
  };
}));
