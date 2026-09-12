'use strict';

const EVENT_TYPES = Object.freeze({
  SESSION_DISCOVERED: 'SESSION_DISCOVERED',
  SESSION_METADATA_UPDATED: 'SESSION_METADATA_UPDATED',
  USER_MESSAGE: 'USER_MESSAGE',
  ASSISTANT_MESSAGE: 'ASSISTANT_MESSAGE',
  TURN_STARTED: 'TURN_STARTED',
  TURN_COMPLETED_SIGNAL: 'TURN_COMPLETED_SIGNAL',
  TURN_FAILED: 'TURN_FAILED',
  TURN_INTERRUPTED: 'TURN_INTERRUPTED',
  TOOL_STARTED: 'TOOL_STARTED',
  TOOL_FINISHED: 'TOOL_FINISHED',
  SUBAGENT_STARTED: 'SUBAGENT_STARTED',
  SUBAGENT_FINISHED: 'SUBAGENT_FINISHED',
  WAITING_USER: 'WAITING_USER',
  EXTERNAL_ACTIVE: 'EXTERNAL_ACTIVE',
  EXTERNAL_TERMINAL: 'EXTERNAL_TERMINAL',
  HEARTBEAT: 'HEARTBEAT',
  MANUAL_COMPLETED: 'MANUAL_COMPLETED',
  ACTIVITY_AFTER_COMPLETION: 'ACTIVITY_AFTER_COMPLETION',
  SESSION_HIDDEN: 'SESSION_HIDDEN',
  SESSION_RESTORED: 'SESSION_RESTORED',
  COMPLETION_CONFIRMED: 'COMPLETION_CONFIRMED',
});

const PUBLIC_STATES = Object.freeze([
  'UNKNOWN', 'IDLE', 'ACTIVE', 'WAITING_USER', 'COMPLETION_CANDIDATE',
  'COMPLETED', 'FAILED', 'INTERRUPTED',
]);

function normalizeEvent(input) {
  if (!input || typeof input !== 'object') throw new TypeError('lifecycle event must be an object');
  const event = { ...input };
  if (event.schemaVersion !== 1) throw new Error('unsupported lifecycle event schema');
  if (!String(event.eventId || '').trim()) throw new Error('lifecycle event requires eventId');
  if (!String(event.sessionRef || '').trim()) throw new Error('lifecycle event requires sessionRef');
  if (!Object.values(EVENT_TYPES).includes(event.type)) throw new Error(`unsupported lifecycle event type: ${event.type}`);
  const timestamp = Number(event.timestamp);
  if (!Number.isFinite(timestamp) || timestamp < 0) throw new Error('lifecycle event requires timestamp');
  return { ...event, timestamp };
}

module.exports = { EVENT_TYPES, PUBLIC_STATES, normalizeEvent };
