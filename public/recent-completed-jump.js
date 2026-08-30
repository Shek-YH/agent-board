'use strict';

(function exposeRecentCompletedJump(root) {
  const DEFAULT_TTL = 30 * 60 * 1000;

  function mapValue(collection, key) {
    return collection && typeof collection.get === 'function' ? collection.get(key) : undefined;
  }

  function findLatestEligibleCompletion(sessions, options = {}) {
    const recentDone = options.recentDone;
    const dismissedRecent = options.dismissedRecent || new Set();
    const liveRefs = options.liveRefs || new Set();
    const runtimeStatuses = options.runtimeStatuses || new Map();
    const now = Number.isFinite(options.now) ? options.now : Date.now();
    const ttl = Number.isFinite(options.ttl) ? options.ttl : DEFAULT_TTL;
    let latest = null;

    for (const session of Array.isArray(sessions) ? sessions : []) {
      const ref = session?.id;
      const completedAt = Number(mapValue(recentDone, ref));
      if (!ref || !Number.isFinite(completedAt)) continue;
      if (dismissedRecent.has(ref) || liveRefs.has(ref) || now - completedAt > ttl) continue;

      const runtime = mapValue(runtimeStatuses, ref) || session.runtime_status;
      const status = runtime?.state || session.status || (liveRefs.has(ref) ? 'running' : 'completed');
      if (status !== 'completed') continue;
      if (!latest || completedAt > latest.completedAt) latest = { session, completedAt };
    }

    return latest;
  }

  root.AgentBoardRecentCompletedJump = { findLatestEligibleCompletion };
})(window);
