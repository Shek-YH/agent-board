'use strict';

const crypto = require('node:crypto');
const { SOURCE_HEALTH_STATES } = require('./enums');

const HEALTH_VALUES = new Set(Object.values(SOURCE_HEALTH_STATES));
const SAFE_IDENTITY_FIELDS = [
  'agent', 'hostId', 'nativeSessionId', 'processId', 'processStartedAt',
  'terminalInstanceId', 'terminalTTY', 'generation',
];

function canonical(runtime) {
  return {
    liveness: runtime.liveness,
    sessionLifecycle: runtime.sessionLifecycle,
    turnState: runtime.turnState,
    activityState: runtime.activityState,
    attentionState: runtime.attentionState,
  };
}

function safeEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object') return null;
  const result = {};
  for (const field of ['evidenceId', 'source', 'signalType', 'occurredAt', 'observedAt', 'confidence', 'authority']) {
    if (evidence[field] !== undefined) result[field] = evidence[field];
  }
  return result;
}

function diagnosticId(runtime, now) {
  const date = new Date(now).toISOString().slice(0, 10).replaceAll('-', '');
  const suffix = crypto.createHash('sha256').update(String(runtime.runtimeSessionKey || runtime.sessionRef)).digest('hex').slice(0, 8);
  return `AB-STATE-${date}-${suffix}`;
}

function safeHealth(sourceHealth = {}) {
  return Object.fromEntries(Object.entries(sourceHealth)
    .filter(([, value]) => HEALTH_VALUES.has(value)));
}

function safeCapabilities(capabilities = {}) {
  return Object.fromEntries(Object.entries(capabilities)
    .filter(([, value]) => typeof value === 'boolean'));
}

function safeIdentity(identity = {}) {
  return Object.fromEntries(SAFE_IDENTITY_FIELDS
    .filter((field) => identity[field] !== undefined && identity[field] !== null)
    .map((field) => [field, identity[field]]));
}

function buildStatusDiagnostics(runtime, options = {}) {
  if (!runtime || typeof runtime !== 'object') throw new TypeError('runtime is required');
  const now = Number(options.now ?? Date.now());
  if (!Number.isFinite(now) || now < 0) throw new TypeError('now must be a non-negative finite number');
  const recent = Array.isArray(runtime.recentEvidence) ? runtime.recentEvidence : [];
  const byId = new Map(recent.map((item) => [item.evidenceId, item]));
  const winningEvidence = {};
  for (const [dimension, evidenceId] of Object.entries(runtime.winningEvidence || {})) {
    const item = safeEvidence(byId.get(evidenceId));
    if (item) winningEvidence[dimension] = item;
    else winningEvidence[dimension] = { evidenceId: String(evidenceId) };
  }
  const conflicts = Array.isArray(options.conflicts) ? options.conflicts.map((item) => ({
    dimension: String(item.dimension || ''),
    evidenceId: String(item.evidenceId || ''),
    reason: String(item.reason || 'unknown'),
  })).filter((item) => item.dimension && item.evidenceId) : [];
  return {
    diagnosticId: diagnosticId(runtime, now),
    canonical: canonical(runtime),
    winningEvidence,
    ignoredEvidence: conflicts,
    sourceHealth: safeHealth(options.sourceHealth),
    conflictCount: conflicts.length,
    timing: {
      lastActivityAt: runtime.lastActivityAt,
      lastEvidenceAt: runtime.lastEvidenceAt,
      lastStrongEvidenceAt: runtime.lastStrongEvidenceAt,
      updatedAt: runtime.updatedAt,
      exportedAt: now,
    },
  };
}

function buildDiagnosticBundle(runtime, options = {}) {
  const status = buildStatusDiagnostics(runtime, options);
  return {
    manifest: { schemaVersion: 1, kind: 'state-engine-diagnostic-bundle' },
    diagnosticId: status.diagnosticId,
    sessionRef: runtime.sessionRef,
    runtimeSessionKey: runtime.runtimeSessionKey,
    canonical: status.canonical,
    winningEvidence: status.winningEvidence,
    ignoredEvidence: status.ignoredEvidence,
    timeline: (Array.isArray(runtime.recentEvidence) ? runtime.recentEvidence : [])
      .slice(-100).map(safeEvidence).filter(Boolean),
    sourceHealth: status.sourceHealth,
    adapterCapabilities: safeCapabilities(options.adapterCapabilities),
    identity: safeIdentity(runtime.identity),
    currentTurnId: runtime.currentTurnId,
    activeToolIds: Array.isArray(runtime.activeToolIds) ? [...runtime.activeToolIds] : [],
    activeSubagentIds: Array.isArray(runtime.activeSubagentIds) ? [...runtime.activeSubagentIds] : [],
    conflictCount: status.conflictCount,
    timing: status.timing,
  };
}

module.exports = { buildStatusDiagnostics, buildDiagnosticBundle };
