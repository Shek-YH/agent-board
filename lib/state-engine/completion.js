'use strict';

const { ACTIVITY_STATES, ATTENTION_STATES, TURN_STATES } = require('./enums');
const { cloneRuntime } = require('./runtime');

function required(value, field) {
  const result = String(value || '').trim();
  if (!result) throw new TypeError(`${field} is required`);
  return result;
}

/** @param {{agent?: string, runtimeSessionKey?: string, turnId?: string, completedAt?: number}} input */
function createCompletionId(input = {}) {
  const { agent, runtimeSessionKey, turnId, completedAt } = input;
  const timestamp = Number(completedAt);
  if (!Number.isFinite(timestamp) || timestamp < 0) throw new TypeError('completedAt must be non-negative');
  return [required(agent, 'agent'), required(runtimeSessionKey, 'runtimeSessionKey'), required(turnId, 'turnId'), timestamp].join(':');
}

function markCompletionNotified(runtime, completionId) {
  const id = required(completionId, 'completionId');
  if (runtime.completionNotificationIds.includes(id)) return { notified: false, runtime };
  return {
    notified: true,
    runtime: cloneRuntime(runtime, {
      completionNotificationIds: [...runtime.completionNotificationIds, id].slice(-4096),
    }),
  };
}

function markTurnSeen(runtime) {
  return cloneRuntime(runtime, { attentionState: ATTENTION_STATES.NONE });
}

function markTurnDone(runtime, turnId) {
  return cloneRuntime(runtime, {
    currentTurnId: required(turnId, 'turnId'),
    turnState: TURN_STATES.COMPLETED,
    activityState: ACTIVITY_STATES.IDLE,
    attentionState: ATTENTION_STATES.COMPLETED_UNSEEN,
  });
}

module.exports = { createCompletionId, markCompletionNotified, markTurnSeen, markTurnDone };
