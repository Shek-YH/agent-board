'use strict';

const { EVENT_TYPES } = require('./events');

const SUPPORTED_AGENTS = new Set(['codex', 'workbuddy']);

function refParts(sessionRef) {
  const [agent, ...rest] = String(sessionRef || '').split(':');
  return { agent, sessionId: rest.join(':') };
}

function eventFor(ref, type, timestamp, eventId, extra = {}) {
  const { agent, sessionId } = refParts(ref);
  return {
    schemaVersion: 1,
    eventId,
    agent,
    sessionId,
    sessionRef: ref,
    timestamp: Number(timestamp) || 0,
    type,
    source: extra.source || `${agent}_adapter`,
    ...extra,
  };
}

function applyStoreMessage(runtime, message) {
  if (!runtime || !message || !SUPPORTED_AGENTS.has(message.agent) || !message.sessionId) return null;
  const ref = `${message.agent}:${message.sessionId}`;
  const timestamp = Number(message.ts) || 0;
  let type;
  if (message.kind === 'turn_start') type = EVENT_TYPES.TURN_STARTED;
  else if (message.kind === 'turn_end') {
    type = message.turnStatus === 'interrupted' || message.turnStatus === 'cancelled'
      ? EVENT_TYPES.TURN_INTERRUPTED
      : message.turnStatus === 'failed' ? EVENT_TYPES.TURN_FAILED : EVENT_TYPES.TURN_COMPLETED_SIGNAL;
  } else if (message.kind === 'message' && message.role === 'user') type = EVENT_TYPES.USER_MESSAGE;
  else if (message.kind === 'message' && message.role === 'assistant') type = EVENT_TYPES.ASSISTANT_MESSAGE;
  else return null;
  const event = eventFor(ref, type, timestamp, `${message.agent}:${message.sourceId || `${message.kind}:${timestamp}`}`, {
    turnId: message.turnId || undefined,
    evidence: message.completionHoldMs ? { completionHoldMs: Number(message.completionHoldMs) } : undefined,
  });
  return runtime.ingest(ref, event);
}

function applyExternalStatus(runtime, sessionRef, status) {
  if (!runtime || !String(sessionRef || '').startsWith('workbuddy:') || !status) return null;
  const timestamp = Number(status.statusAt) || 0;
  if (!timestamp) return null;
  const type = status.terminal ? EVENT_TYPES.EXTERNAL_TERMINAL : status.active ? EVENT_TYPES.EXTERNAL_ACTIVE : null;
  if (!type) return null;
  return runtime.ingest(sessionRef, eventFor(sessionRef, type, timestamp, `external:${sessionRef}:${timestamp}:${status.status || type}`, {
    evidence: { state: status.status || (status.terminal ? 'completed' : 'active') },
    source: 'workbuddy_db',
  }));
}

function applyHeartbeat(runtime, sessionRef, alive, observedAt) {
  if (!runtime || !alive || !String(sessionRef || '').startsWith('workbuddy:')) return null;
  const timestamp = Number(observedAt) || 0;
  if (!timestamp) return null;
  return runtime.ingest(sessionRef, eventFor(sessionRef, EVENT_TYPES.HEARTBEAT, timestamp, `heartbeat:${sessionRef}:${timestamp}`, {
    source: 'workbuddy_heartbeat',
  }));
}

function applyManualCompletion(runtime, sessionRef, timestamp) {
  if (!runtime || !sessionRef || !timestamp) return null;
  return runtime.ingest(sessionRef, eventFor(sessionRef, EVENT_TYPES.MANUAL_COMPLETED, timestamp, `manual:${sessionRef}:${timestamp}`, {
    source: 'store_manual_status',
  }));
}

function applyCompletionConfirmed(runtime, sessionRef, timestamp, source = 'store_completion') {
  if (!runtime || !sessionRef || !timestamp) return null;
  return runtime.ingest(sessionRef, eventFor(sessionRef, EVENT_TYPES.COMPLETION_CONFIRMED, timestamp, `completion:${sessionRef}:${timestamp}`, {
    source,
  }));
}

function applyWorkBuddyRuntimeStatus(runtime, sessionRef, status) {
  if (!runtime || !String(sessionRef || '').startsWith('workbuddy:') || !status) return null;
  const timestamp = Number(status.lastEventAt || status.completedAt || status.updatedAt) || 0;
  if (!timestamp) return null;
  const current = String(status.state || '').toLowerCase();
  let type;
  if (current === 'waiting_user' || current === 'waiting_user_input') type = EVENT_TYPES.WAITING_USER;
  else if (current === 'candidate_completion') type = EVENT_TYPES.TURN_COMPLETED_SIGNAL;
  else if (current === 'failed') type = EVENT_TYPES.TURN_FAILED;
  else if (current === 'interrupted' || current === 'cancelled') type = EVENT_TYPES.TURN_INTERRUPTED;
  else if (current === 'completed' || current === 'terminated' || current === 'error') type = EVENT_TYPES.EXTERNAL_TERMINAL;
  else if (['planning', 'running', 'running_tool', 'running_subagent', 'thinking'].includes(current)) type = EVENT_TYPES.EXTERNAL_ACTIVE;
  else return null;
  return runtime.ingest(sessionRef, eventFor(sessionRef, type, timestamp, `runtime:${sessionRef}:${current}:${timestamp}`, {
    evidence: { state: current },
    source: 'workbuddy_hooks',
  }));
}

module.exports = {
  applyStoreMessage,
  applyExternalStatus,
  applyHeartbeat,
  applyManualCompletion,
  applyCompletionConfirmed,
  applyWorkBuddyRuntimeStatus,
};
