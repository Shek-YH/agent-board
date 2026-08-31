'use strict';

const crypto = require('node:crypto');

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

function fingerprint(value) {
  return crypto.createHash('sha256').update(String(value == null ? '' : value).trim(), 'utf8').digest('hex');
}

function messageTimestamp(message) {
  return finiteTimestamp(message && (message.ts ?? message.timestamp));
}

function hasHumanIntervention(session, dispatchRecord) {
  const messages = Array.isArray(session && session.messages) ? session.messages : [];
  const deliveryProof = dispatchRecord && dispatchRecord.deliveryProof || {};
  const proofId = String(deliveryProof.proofIdFingerprint || '').trim().toLowerCase();
  const expectedFingerprint = String(dispatchRecord && dispatchRecord.instructionFingerprint || '').trim().toLowerCase();
  const boundary = finiteTimestamp(
    deliveryProof.timestamp,
    dispatchRecord && dispatchRecord.completedAt,
    dispatchRecord && dispatchRecord.startedAt,
  );
  if (!messages.length || (!boundary && !proofId && !expectedFingerprint)) return false;

  const deliveredMessage = messages.find((message) => {
    if (!message || message.role !== 'user') return false;
    if (proofId && message.source_id && fingerprint(message.source_id).slice(0, 32) === proofId) return true;
    return Boolean(expectedFingerprint && fingerprint(message.text) === expectedFingerprint
      && (!boundary || messageTimestamp(message) <= boundary));
  });

  return messages.some((message) => {
    if (!message || message.role !== 'user' || message === deliveredMessage) return false;
    const timestamp = messageTimestamp(message);
    return Boolean(timestamp && boundary && timestamp > boundary);
  });
}

function hasHumanInterventionBeforeDispatch(session, workflow) {
  const messages = Array.isArray(session && session.messages) ? session.messages : [];
  const workflowCreatedAt = finiteTimestamp(workflow && workflow.createdAt);
  if (!messages.length || !workflowCreatedAt) return false;
  return messages.some((message) => message && message.role === 'user'
    && messageTimestamp(message) > workflowCreatedAt);
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

      if (hasHumanIntervention(session, dispatchRecord)) {
        return { status: 'waiting_user', completed: false, reasonCode: 'HUMAN_INTERVENTION', observedAt: now() };
      }

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

module.exports = { createCompletionDetector, finiteTimestamp, hasHumanInterventionBeforeDispatch };
