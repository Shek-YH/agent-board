'use strict';

const COMPLETED_STATES = new Set(['completed']);
const WAITING_STATES = new Set(['waiting_user_input', 'waiting_approval']);

function finiteTimestamp(...values) {
  for (const value of values) {
    const timestamp = Number(value);
    if (Number.isFinite(timestamp) && timestamp >= 0) return timestamp;
  }
  return 0;
}

function unknown(reasonCode, extra = {}) {
  return { status: 'unknown', completed: false, reasonCode, ...extra };
}

/**
 * Adapts the normalized session runtime status into the AutoLoop detector
 * contract. A completion is accepted only when the runtime reports an
 * explicit terminal state after the current dispatch started.
 */
function createCompletionDetector({ getSession, now = () => Date.now() } = {}) {
  if (typeof getSession !== 'function') throw new TypeError('getSession is required');

  return {
    async detect({ workflow, dispatchRecord } = {}) {
      const sessionRef = workflow && workflow.binding && workflow.binding.sessionRef;
      if (!sessionRef) return unknown('SESSION_BINDING_MISSING');

      let session;
      try {
        session = await getSession(sessionRef);
      } catch {
        return unknown('SESSION_STATUS_UNAVAILABLE');
      }
      const runtime = session && session.runtime_status;
      if (!runtime || typeof runtime !== 'object') return unknown('SESSION_STATUS_UNAVAILABLE');

      const state = String(runtime.state || runtime.status || '').trim().toLowerCase();
      if (WAITING_STATES.has(state)) {
        return { status: 'waiting_user', completed: false, reasonCode: 'PERMISSION_REQUIRED' };
      }
      if (['blocked', 'failed', 'interrupted'].includes(state)) {
        return { status: 'blocked', completed: false, reasonCode: 'AGENT_FAILED' };
      }
      if (!COMPLETED_STATES.has(state)) {
        return { status: 'running', completed: false, reasonCode: 'TURN_IN_PROGRESS' };
      }

      const completedAt = finiteTimestamp(
        runtime.completedAt,
        runtime.lastStopAt,
        runtime.lastCompletionAt,
        runtime.lastEventAt,
      );
      const dispatchStartedAt = finiteTimestamp(dispatchRecord && dispatchRecord.startedAt);
      if (!completedAt || (dispatchStartedAt && completedAt < dispatchStartedAt)) {
        return unknown('STALE_COMPLETION_SIGNAL', { completedAt, observedAt: now() });
      }

      return {
        status: 'completed',
        completed: true,
        reasonCode: 'TURN_COMPLETED',
        completedAt,
        evidence: [],
      };
    },
  };
}

module.exports = { createCompletionDetector, finiteTimestamp };
