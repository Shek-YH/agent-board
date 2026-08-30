'use strict';

const AUTO_STATES = Object.freeze([
  'OFF', 'PREFLIGHT', 'WAITING_AGENT', 'REVIEWING', 'DISPATCHING',
  'VERIFYING', 'PAUSED', 'BLOCKED', 'DONE', 'STOPPED',
]);

const TRANSITIONS = Object.freeze({
  OFF: new Set(['PREFLIGHT', 'PAUSED', 'STOPPED']),
  PREFLIGHT: new Set(['WAITING_AGENT', 'PAUSED', 'BLOCKED', 'STOPPED']),
  WAITING_AGENT: new Set(['REVIEWING', 'VERIFYING', 'PAUSED', 'BLOCKED', 'STOPPED']),
  REVIEWING: new Set(['WAITING_AGENT', 'DISPATCHING', 'DONE', 'PAUSED', 'BLOCKED', 'STOPPED']),
  DISPATCHING: new Set(['VERIFYING', 'PAUSED', 'BLOCKED', 'STOPPED']),
  VERIFYING: new Set(['WAITING_AGENT', 'REVIEWING', 'DONE', 'PAUSED', 'BLOCKED', 'STOPPED']),
  PAUSED: new Set(['PREFLIGHT', 'DONE', 'STOPPED']),
  BLOCKED: new Set(['PREFLIGHT', 'DONE', 'STOPPED']),
  DONE: new Set(),
  STOPPED: new Set(),
});

const STATUS_TO_STATE = Object.freeze({
  draft: 'OFF', queued: 'PREFLIGHT', running: 'WAITING_AGENT', waiting_user: 'PAUSED',
  verifying: 'VERIFYING', completed: 'DONE', failed: 'BLOCKED', paused: 'PAUSED',
});
const STATE_TO_STATUS = Object.freeze({
  OFF: 'draft', PREFLIGHT: 'queued', WAITING_AGENT: 'running', REVIEWING: 'running',
  DISPATCHING: 'running', VERIFYING: 'verifying', PAUSED: 'paused', BLOCKED: 'failed',
  DONE: 'completed', STOPPED: 'paused',
});

function assertState(state) {
  if (!AUTO_STATES.includes(state)) throw new TypeError('unknown auto state: ' + state);
  return state;
}

function assertAutoTransition(current, next) {
  assertState(current);
  assertState(next);
  if (current !== next && !TRANSITIONS[current].has(next)) {
    throw new Error(`illegal auto transition: ${current} -> ${next}`);
  }
  return next;
}

function autoStateForStatus(status) {
  return STATUS_TO_STATE[status] || 'OFF';
}

function statusForAutoState(state) {
  return STATE_TO_STATUS[assertState(state)];
}

module.exports = { AUTO_STATES, TRANSITIONS, assertAutoTransition, autoStateForStatus, statusForAutoState };
