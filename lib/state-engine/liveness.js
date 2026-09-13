'use strict';

const { normalizeEvidence } = require('./evidence');
const { EVENT_TYPES, LIVENESS_STATES, SOURCE_HEALTH_STATES } = require('./enums');

const HEALTH_VALUES = new Set(Object.values(SOURCE_HEALTH_STATES));

function createProcessLivenessService(options = {}) {
  const deadAfterMisses = Number(options.deadAfterMisses ?? 2);
  const deadAfterMs = Number(options.deadAfterMs ?? 6000);
  if (!Number.isInteger(deadAfterMisses) || deadAfterMisses < 1) throw new TypeError('deadAfterMisses must be a positive integer');
  if (!Number.isFinite(deadAfterMs) || deadAfterMs < 0) throw new TypeError('deadAfterMs must be non-negative');
  const sessions = new Map();
  const sourceHealth = new Map([['process', SOURCE_HEALTH_STATES.HEALTHY]]);

  function observe(input = {}) {
    const agent = String(input.agent || '').trim();
    const sessionRef = String(input.sessionRef || '').trim();
    const observedAt = Number(input.observedAt);
    if (!agent) throw new TypeError('agent is required');
    if (!sessionRef) throw new TypeError('sessionRef is required');
    if (!Number.isFinite(observedAt) || observedAt < 0) throw new TypeError('observedAt must be non-negative');
    /** @type {{state: string, missingSince: number|null, consecutiveMisses: number, lastObservedAt?: number, processId?: number|null, processStartedAt?: number|null}} */
    const current = sessions.get(sessionRef) || { state: LIVENESS_STATES.UNKNOWN, missingSince: null, consecutiveMisses: 0 };
    const identityMatched = input.identityMatched !== false;
    const alive = input.alive === true;
    /** @type {string} */
    let state = LIVENESS_STATES.UNKNOWN;
    if (identityMatched && alive) {
      state = LIVENESS_STATES.ALIVE;
      current.missingSince = null;
      current.consecutiveMisses = 0;
    } else if (identityMatched) {
      current.missingSince ??= observedAt;
      current.consecutiveMisses += 1;
      state = current.consecutiveMisses >= deadAfterMisses || observedAt - current.missingSince >= deadAfterMs
        ? LIVENESS_STATES.DEAD : LIVENESS_STATES.SUSPECT;
    } else {
      current.missingSince = null;
      current.consecutiveMisses = 0;
    }
    current.state = state;
    current.lastObservedAt = observedAt;
    current.processId = Number.isInteger(Number(input.processId)) ? Number(input.processId) : null;
    current.processStartedAt = Number.isFinite(Number(input.processStartedAt)) ? Number(input.processStartedAt) : null;
    sessions.set(sessionRef, current);
    const signalType = state === LIVENESS_STATES.DEAD
      ? EVENT_TYPES.PROCESS_DEAD : alive && identityMatched ? EVENT_TYPES.PROCESS_SEEN : EVENT_TYPES.PROCESS_MISSING;
    const value = { identityConfirmed: identityMatched };
    if (current.processId !== null) value.processId = current.processId;
    const evidence = normalizeEvidence({
      evidenceId: `process:${sessionRef}:${observedAt}:${signalType}`,
      agent, sessionRef, source: 'process', signalType, value,
      occurredAt: observedAt, observedAt, confidence: identityMatched ? 0.96 : 0.4, authority: 70,
    });
    return { state, evidence };
  }

  return {
    observe,
    get(sessionRef) {
      const current = sessions.get(String(sessionRef || ''));
      return current ? { ...current } : null;
    },
    setSourceHealth(source, status) {
      if (!HEALTH_VALUES.has(status)) throw new TypeError('unsupported source health');
      sourceHealth.set(String(source || 'process'), status);
    },
    getSourceHealth() { return Object.fromEntries(sourceHealth); },
  };
}

module.exports = { createProcessLivenessService };
