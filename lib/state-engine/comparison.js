'use strict';

const { SESSION_LIFECYCLE_STATES, TURN_STATES } = require('./enums');
const { projectLegacyState } = require('./projection');

const LEGACY_STATES = new Set(['running', 'waiting_user', 'waiting_user_input', 'completed', 'failed', 'interrupted', 'unknown']);

function safeLegacyState(value) {
  const state = String(value || '').trim().toLowerCase();
  return LEGACY_STATES.has(state) ? state : 'unknown';
}

function compareLegacyState(legacyState, runtime) {
  if (!runtime || typeof runtime !== 'object') throw new TypeError('runtime is required');
  const legacy = safeLegacyState(legacyState);
  const projectedLegacy = projectLegacyState(runtime);
  const v2 = {
    liveness: runtime.liveness,
    sessionLifecycle: runtime.sessionLifecycle,
    turnState: runtime.turnState,
    activityState: runtime.activityState,
    attentionState: runtime.attentionState,
  };
  const reasons = [];
  if (legacy !== projectedLegacy) reasons.push('legacy_projection_differs');
  if (legacy === 'completed' && runtime.sessionLifecycle !== SESSION_LIFECYCLE_STATES.CLOSED) reasons.push('session_open');
  if (legacy === 'completed' && runtime.turnState !== TURN_STATES.COMPLETED) reasons.push('turn_not_completed');
  return { legacy, v2, divergence: reasons.length > 0, reasons };
}

module.exports = { compareLegacyState };
