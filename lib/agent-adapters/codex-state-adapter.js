'use strict';

const { EVIDENCE_SOURCES, EVENT_TYPES } = require('../state-engine/enums');
const { normalizeEvidence } = require('../state-engine/evidence');
const { resolveStateEngineMode } = require('../state-engine/projection');
const { loadAgentManifest } = require('../state-engine/manifest');

const CODEX_MANIFEST = loadAgentManifest('codex');

function safeValue(event) {
  const value = {};
  const turnId = event.turnId ? String(event.turnId) : '';
  if (turnId) value.turnId = turnId;
  const toolId = event.toolId || event.tool_id;
  if (toolId) value.toolId = String(toolId);
  const toolKind = event.toolKind || event.toolType;
  if (toolKind) value.kind = String(toolKind);
  const subagentId = event.subagentId || event.subagent_id;
  if (subagentId) value.subagentId = String(subagentId);
  if (event.sessionRole === 'child') {
    value.sessionRole = 'child';
    if (event.parentSessionId) value.parentSessionRef = `codex:${String(event.parentSessionId)}`;
    if (event.rootSessionId) value.rootSessionRef = `codex:${String(event.rootSessionId)}`;
  }
  if (Number.isFinite(Number(event.completionHoldMs)) && Number(event.completionHoldMs) > 0) {
    value.completionHoldMs = Number(event.completionHoldMs);
  }
  return value;
}

function signalForEvent(event) {
  if (event.kind === 'turn_start') return EVENT_TYPES.TURN_STARTED;
  if (event.kind === 'turn_end') {
    if (event.turnStatus === 'interrupted' || event.turnStatus === 'cancelled') return EVENT_TYPES.TURN_INTERRUPTED;
    if (event.turnStatus === 'failed') return EVENT_TYPES.TURN_FAILED;
    return EVENT_TYPES.TURN_COMPLETION_SIGNAL;
  }
  if (event.kind === 'message') return event.role === 'user' ? EVENT_TYPES.USER_MESSAGE : EVENT_TYPES.ASSISTANT_MESSAGE;
  if (event.kind === 'tool_start') return EVENT_TYPES.TOOL_STARTED;
  if (event.kind === 'tool_end') return EVENT_TYPES.TOOL_FINISHED;
  if (event.kind === 'subagent_start') return EVENT_TYPES.SUBAGENT_STARTED;
  if (event.kind === 'subagent_end') return EVENT_TYPES.SUBAGENT_FINISHED;
  if (event.kind === 'session_start') return EVENT_TYPES.SESSION_STARTED;
  if (event.kind === 'session_end') return EVENT_TYPES.SESSION_CLOSED;
  if (event.kind === 'heartbeat') return EVENT_TYPES.TRANSCRIPT_ACTIVITY;
  return null;
}

function legacyEventToEvidence(event, options = {}) {
  if (!event || typeof event !== 'object') return null;
  const signalType = signalForEvent(event);
  const sessionId = String(event.sessionId || '').trim();
  if (!signalType || !sessionId) return null;
  const sessionRef = String(event.sessionRef || `codex:${sessionId}`).trim();
  const occurredAt = Number(event.occurredAt ?? event.ts);
  const observedAt = Number(options.observedAt ?? event.observedAt ?? occurredAt);
  if (!Number.isFinite(occurredAt) || occurredAt < 0 || !Number.isFinite(observedAt) || observedAt < 0) return null;
  const evidenceId = String(event.evidenceId || event.sourceId || `${sessionRef}:${event.kind}:${occurredAt}`).trim();
  if (!evidenceId) return null;
  return normalizeEvidence({
    evidenceId,
    agent: 'codex',
    sessionRef,
    source: EVIDENCE_SOURCES.JSONL,
    signalType,
    value: safeValue(event),
    occurredAt,
    observedAt,
    sourceSequence: event.sourceSequence ?? event.seq,
    sourceGeneration: event.sourceGeneration ?? event.generation,
    confidence: Number(options.confidence ?? 0.99),
    authority: Number(options.authority ?? 90),
  });
}

function createCodexStateAdapter({ emit = (_item) => {}, mode = process.env.STATE_ENGINE_V2 } = {}) {
  if (typeof emit !== 'function') throw new TypeError('emit must be a function');
  function collect(events, options = {}) {
      if (resolveStateEngineMode(mode) === 'off') return [];
      const result = [];
      for (const event of Array.isArray(events) ? events : []) {
        const evidence = legacyEventToEvidence(event, options);
        if (!evidence) continue;
        result.push(evidence);
        emit(evidence);
      }
      return result;
  }
  return {
    agentId: 'codex',
    capabilities: CODEX_MANIFEST.capabilities,
    collect,
    collectEvidence: collect,
  };
}

module.exports = { createCodexStateAdapter, legacyEventToEvidence };
