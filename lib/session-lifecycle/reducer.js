'use strict';

const { normalizeEvent } = require('./events');

const TERMINAL_STATES = new Set(['COMPLETED', 'FAILED', 'INTERRUPTED']);
const REAL_ACTIVITY_TYPES = new Set([
  'USER_MESSAGE', 'ASSISTANT_MESSAGE', 'TURN_STARTED', 'TOOL_STARTED',
  'TOOL_FINISHED', 'EXTERNAL_ACTIVE', 'ACTIVITY_AFTER_COMPLETION',
]);

function initialState(seed = {}) {
  const state = {
    publicState: 'UNKNOWN',
    turnId: null,
    updatedAt: 0,
    lastEventAt: 0,
    lastActivityAt: 0,
    terminalAt: 0,
    terminalState: null,
    completionCandidateAt: 0,
    seenEventIds: [],
    topology: {},
    ...seed,
  };
  state.seenEventIds = [...(seed.seenEventIds || [])];
  return state;
}

function withSeen(state, eventId) {
  const seen = [...state.seenEventIds, eventId];
  return { ...state, seenEventIds: seen.slice(-4096) };
}

function terminalStateFor(event) {
  if (event.type === 'TURN_FAILED') return 'FAILED';
  if (event.type === 'TURN_INTERRUPTED') return 'INTERRUPTED';
  const candidate = String(event.evidence && (event.evidence.publicState || event.evidence.state) || '').toUpperCase();
  return ['FAILED', 'INTERRUPTED'].includes(candidate) ? candidate : 'COMPLETED';
}

function applyEvent(previous, input) {
  const state = previous && typeof previous === 'object' && Array.isArray(previous.seenEventIds)
    ? previous
    : initialState(previous);
  const event = normalizeEvent(input);
  if (state.seenEventIds.includes(event.eventId)) return previous || state;
  if (event.topology && event.topology.role === 'child') return previous || state;

  const next = withSeen(state, event.eventId);
  if (event.timestamp < state.lastEventAt) return previous || next;
  if (TERMINAL_STATES.has(state.publicState)
    && event.timestamp <= state.terminalAt
    && !REAL_ACTIVITY_TYPES.has(event.type)) return next;

  const result = {
    ...next,
    updatedAt: event.timestamp,
    lastEventAt: event.timestamp,
    topology: event.topology ? { ...state.topology, ...event.topology } : state.topology,
  };
  if (event.turnId) result.turnId = String(event.turnId);

  if (REAL_ACTIVITY_TYPES.has(event.type)) {
    result.publicState = 'ACTIVE';
    result.lastActivityAt = event.timestamp;
    result.completionCandidateAt = 0;
    if (TERMINAL_STATES.has(state.publicState) && event.timestamp > state.terminalAt) {
      result.terminalAt = 0;
      result.terminalState = null;
    }
    return result;
  }

  if (event.type === 'SESSION_DISCOVERED') {
    if (state.publicState === 'UNKNOWN') result.publicState = 'IDLE';
  } else if (event.type === 'WAITING_USER') {
    result.publicState = 'WAITING_USER';
    result.completionCandidateAt = 0;
  } else if (event.type === 'TURN_COMPLETED_SIGNAL') {
    result.publicState = 'COMPLETION_CANDIDATE';
    result.completionCandidateAt = event.timestamp;
  } else if (event.type === 'COMPLETION_CONFIRMED' || event.type === 'MANUAL_COMPLETED' || event.type === 'EXTERNAL_TERMINAL') {
    result.publicState = event.type === 'EXTERNAL_TERMINAL' ? terminalStateFor(event) : 'COMPLETED';
    result.terminalState = result.publicState;
    result.terminalAt = event.timestamp;
    result.completionCandidateAt = 0;
  } else if (event.type === 'TURN_FAILED' || event.type === 'TURN_INTERRUPTED') {
    result.publicState = terminalStateFor(event);
    result.terminalState = result.publicState;
    result.terminalAt = event.timestamp;
    result.completionCandidateAt = 0;
  } else if (event.type === 'SESSION_HIDDEN' || event.type === 'SESSION_RESTORED' || event.type === 'HEARTBEAT' || event.type === 'SESSION_METADATA_UPDATED' || event.type === 'SUBAGENT_STARTED' || event.type === 'SUBAGENT_FINISHED') {
    return result;
  }
  return result;
}

module.exports = { TERMINAL_STATES, initialState, applyEvent };
