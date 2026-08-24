'use strict';

const TERMINAL_STATUSES = new Set(['completed', 'interrupted', 'failed']);
const STALE_ACTIVE_MS = 10 * 60 * 1000;

function createCodexRuntimeState(threadId) {
  return {
    threadId: String(threadId || ''),
    threadStatus: 'unknown',
    activeFlags: [],
    activeTurnId: null,
    latestTurnId: null,
    latestTurnStatus: null,
    monitorState: 'unknown',
    startedAt: null,
    completedAt: null,
    lastEventAt: 0,
    pendingCompletionAt: 0,
    pendingCompletionStatus: null,
    source: 'jsonl',
  };
}

function eventTime(state, event) {
  return Number(event && event.ts) || state.lastEventAt || 0;
}

function terminalState(turnStatus) {
  if (turnStatus === 'interrupted') return 'interrupted';
  if (turnStatus === 'failed') return 'failed';
  return 'completed';
}

function applyCodexTurnEvent(state, event) {
  const next = { ...state, activeFlags: [...(state.activeFlags || [])] };
  const ts = eventTime(state, event);
  next.lastEventAt = Math.max(next.lastEventAt || 0, ts);

  if (event.kind === 'turn_start') {
    next.activeTurnId = event.turnId || null;
    next.latestTurnId = event.turnId || next.latestTurnId;
    next.latestTurnStatus = 'inProgress';
    next.threadStatus = 'active';
    next.monitorState = 'running';
    next.activeFlags = [];
    next.pendingCompletionAt = 0;
    next.pendingCompletionStatus = null;
    next.startedAt = ts || next.startedAt;
    next.completedAt = null;
    return next;
  }

  if (event.kind !== 'turn_end') return next;

  const status = event.turnStatus || 'completed';
  next.activeTurnId = null;
  next.latestTurnId = event.turnId || next.latestTurnId;
  next.latestTurnStatus = status;
  next.activeFlags = [];
  next.completedAt = ts || next.completedAt;

  if (status === 'completed' && Number(event.holdMs) > 0) {
    next.threadStatus = 'active';
    next.monitorState = 'running';
    next.pendingCompletionAt = ts + Number(event.holdMs);
    next.pendingCompletionStatus = status;
    return next;
  }

  next.threadStatus = 'idle';
  next.monitorState = terminalState(status);
  next.pendingCompletionAt = 0;
  next.pendingCompletionStatus = null;
  return next;
}

function applyCodexThreadStatus(state, status, ts) {
  const next = {
    ...state,
    activeFlags: Array.isArray(status && status.activeFlags) ? [...status.activeFlags] : [],
    lastEventAt: Math.max(state.lastEventAt || 0, Number(ts) || 0),
  };
  next.threadStatus = status && typeof status.type === 'string' ? status.type : 'unknown';
  if (next.threadStatus === 'active') next.monitorState = 'running';
  else if (next.threadStatus === 'idle' && !TERMINAL_STATUSES.has(next.latestTurnStatus)) next.monitorState = 'idle';
  else if (next.threadStatus === 'notLoaded') next.monitorState = 'not_loaded';
  else if (next.threadStatus === 'systemError') next.monitorState = 'system_error';
  return next;
}

function applyCodexActivity(state, ts) {
  const next = {
    ...state,
    lastEventAt: Math.max(state.lastEventAt || 0, Number(ts) || 0),
  };
  if (!next.pendingCompletionAt && !TERMINAL_STATUSES.has(next.latestTurnStatus)) {
    next.threadStatus = 'active';
    next.monitorState = 'running';
  }
  return next;
}

function getCodexDisplayStatus(state, now = Date.now()) {
  if (!state) return 'unknown';

  if (state.pendingCompletionAt) {
    if (now < state.pendingCompletionAt) return 'running';
    return terminalState(state.pendingCompletionStatus || state.latestTurnStatus);
  }

  if (state.threadStatus === 'active') {
    if (state.activeFlags.includes('waitingOnApproval')) return 'waiting_approval';
    if (state.activeFlags.includes('waitingOnUserInput')) return 'waiting_user_input';
    if (state.lastEventAt && now - state.lastEventAt > STALE_ACTIVE_MS) return 'stale_active';
    return 'running';
  }

  if (TERMINAL_STATUSES.has(state.monitorState)) return state.monitorState;
  if (TERMINAL_STATUSES.has(state.latestTurnStatus)) return terminalState(state.latestTurnStatus);
  if (state.threadStatus === 'idle') return 'idle';
  if (state.threadStatus === 'notLoaded') return 'not_loaded';
  if (state.threadStatus === 'systemError') return 'system_error';
  return state.monitorState || 'unknown';
}

function toPublicCodexStatus(state, now = Date.now()) {
  if (!state) return null;
  return {
    threadId: state.threadId,
    threadStatus: state.threadStatus,
    activeFlags: [...state.activeFlags],
    activeTurnId: state.activeTurnId,
    latestTurnId: state.latestTurnId,
    latestTurnStatus: state.latestTurnStatus,
    state: getCodexDisplayStatus(state, now),
    startedAt: state.startedAt,
    completedAt: state.completedAt,
    lastEventAt: state.lastEventAt,
    source: state.source,
  };
}

module.exports = {
  createCodexRuntimeState,
  applyCodexTurnEvent,
  applyCodexThreadStatus,
  applyCodexActivity,
  getCodexDisplayStatus,
  toPublicCodexStatus,
};
