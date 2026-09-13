'use strict';

const { EVIDENCE_SOURCES, EVENT_TYPES } = require('../state-engine/enums');
const { normalizeEvidence } = require('../state-engine/evidence');
const { resolveStateEngineMode } = require('../state-engine/projection');
const { loadAgentManifest } = require('../state-engine/manifest');

const WORKBUDDY_MANIFEST = loadAgentManifest('workbuddy');

function sessionRefFor(sessionId) {
  return `workbuddy:${String(sessionId || '').trim()}`;
}

function baseValue(event) {
  const value = {};
  const name = String(event.event || event.hook_event_name || '').trim();
  const fields = [['turnId', 'turn_id']];
  if (['PreToolUse', 'PostToolUse', 'PostToolUseFailure'].includes(name)) fields.push(['toolId', 'tool_use_id']);
  if (['SubagentStart', 'SubagentStop'].includes(name)) fields.push(['subagentId', 'subagent_id']);
  if (['TaskCreated', 'TaskCompleted'].includes(name)) fields.push(['taskId', 'task_id'], ['taskType', 'task_type']);
  if (name === 'Notification') fields.push(['notificationType', 'notification_type']);
  for (const [target, source] of fields) {
    if (event[source] !== undefined && event[source] !== null && String(event[source]).trim()) value[target] = String(event[source]).trim();
  }
  if (event.event === 'TaskCreated' || event.event === 'TaskCompleted') value.kind = 'background';
  return value;
}

function signalForEvent(event) {
  const name = String(event.event || event.hook_event_name || '').trim();
  if (name === 'SessionStart') return EVENT_TYPES.SESSION_STARTED;
  if (name === 'UserPromptSubmit') return EVENT_TYPES.USER_MESSAGE;
  if (name === 'PreToolUse') return EVENT_TYPES.TOOL_STARTED;
  if (name === 'PostToolUse' || name === 'PostToolUseFailure') return EVENT_TYPES.TOOL_FINISHED;
  if (name === 'PermissionRequest') return EVENT_TYPES.WAITING_APPROVAL;
  if (name === 'PermissionDenied' || name === 'StopFailure') return EVENT_TYPES.TURN_FAILED;
  if (name === 'SubagentStart') return EVENT_TYPES.SUBAGENT_STARTED;
  if (name === 'SubagentStop') return EVENT_TYPES.SUBAGENT_FINISHED;
  if (name === 'TaskCreated') return EVENT_TYPES.TOOL_STARTED;
  if (name === 'TaskCompleted') return EVENT_TYPES.TOOL_FINISHED;
  if (name === 'Elicitation') return EVENT_TYPES.WAITING_USER;
  if (name === 'Notification') {
    const notification = String(event.notification_type || '').toLowerCase();
    if (notification === 'permission_prompt') return EVENT_TYPES.WAITING_APPROVAL;
    if (notification === 'idle_prompt' || notification === 'elicitation_dialog') return EVENT_TYPES.WAITING_USER;
  }
  if (name === 'Stop') return event.stop_hook_active === true || event.stopHookActive === true
    ? EVENT_TYPES.TRANSCRIPT_ACTIVITY : EVENT_TYPES.TURN_COMPLETION_SIGNAL;
  if (name === 'SessionEnd') return EVENT_TYPES.SESSION_CLOSED;
  return null;
}

function hookEventToEvidence(event, options = {}) {
  if (!event || typeof event !== 'object') return null;
  const sessionId = String(event.session_id || event.sessionId || '').trim();
  const signalType = signalForEvent(event);
  if (!sessionId || !signalType) return null;
  const occurredAt = Number(event.ts ?? event.timestamp);
  const observedAt = Number(options.observedAt ?? event.observedAt ?? occurredAt);
  if (!Number.isFinite(occurredAt) || occurredAt < 0 || !Number.isFinite(observedAt) || observedAt < 0) return null;
  const sessionRef = sessionRefFor(sessionId);
  const eventId = String(event.event_id || event.eventId || `${sessionRef}:${event.event || signalType}:${occurredAt}`).trim();
  const value = baseValue(event);
  if (event.session_role === 'child' || event.sessionRole === 'child') value.sessionRole = 'child';
  return normalizeEvidence({
    evidenceId: eventId,
    agent: 'workbuddy',
    sessionRef,
    source: EVIDENCE_SOURCES.NATIVE_HOOK,
    signalType,
    value,
    occurredAt,
    observedAt,
    sourceSequence: event.seq ?? event.sequence,
    sourceGeneration: event.generation,
    confidence: Number(options.confidence ?? 0.99),
    authority: Number(options.authority ?? 100),
  });
}

function heartbeatToEvidence(input, options = {}) {
  if (!input || typeof input !== 'object') return null;
  const sessionId = String(input.sessionId || input.session_id || '').trim();
  const occurredAt = Number(input.lastHeartbeat ?? input.timestamp);
  const observedAt = Number(options.observedAt ?? occurredAt);
  if (!sessionId || !Number.isFinite(occurredAt) || occurredAt < 0 || !Number.isFinite(observedAt) || observedAt < 0) return null;
  const sessionRef = sessionRefFor(sessionId);
  return normalizeEvidence({
    evidenceId: `heartbeat:${sessionRef}:${occurredAt}`,
    agent: 'workbuddy', sessionRef, source: EVIDENCE_SOURCES.HEARTBEAT,
    signalType: EVENT_TYPES.HEARTBEAT, value: {}, occurredAt, observedAt,
    confidence: Number(options.confidence ?? 0.95), authority: Number(options.authority ?? 75),
  });
}

function databaseStatusToEvidence(input, options = {}) {
  if (!input || typeof input !== 'object') return null;
  const sessionId = String(input.sessionId || input.session_id || '').trim();
  const occurredAt = Number(input.statusAt ?? input.timestamp);
  const observedAt = Number(options.observedAt ?? occurredAt);
  if (!sessionId || !Number.isFinite(occurredAt) || occurredAt < 0 || !Number.isFinite(observedAt) || observedAt < 0) return null;
  const terminal = input.terminal === true || ['completed', 'terminated', 'closed'].includes(String(input.status || '').toLowerCase());
  const active = input.active === true || ['active', 'running'].includes(String(input.status || '').toLowerCase());
  if (!terminal && !active) return null;
  const sessionRef = sessionRefFor(sessionId);
  return normalizeEvidence({
    evidenceId: `database:${sessionRef}:${occurredAt}:${terminal ? 'terminal' : 'active'}`,
    agent: 'workbuddy', sessionRef, source: EVIDENCE_SOURCES.DATABASE,
    signalType: terminal ? EVENT_TYPES.SESSION_CLOSED : EVENT_TYPES.PROCESS_SEEN,
    value: { status: String(input.status || (terminal ? 'completed' : 'active')) },
    occurredAt, observedAt, confidence: Number(options.confidence ?? 0.98), authority: Number(options.authority ?? 85),
  });
}

function createWorkBuddyStateAdapter({ emit = (_item) => {}, mode = process.env.STATE_ENGINE_V2 } = {}) {
  if (typeof emit !== 'function') throw new TypeError('emit must be a function');
  function collect(items, mapper, options) {
    if (resolveStateEngineMode(mode) === 'off') return [];
    const result = [];
    for (const item of Array.isArray(items) ? items : []) {
      const evidence = mapper(item, options);
      if (!evidence) continue;
      result.push(evidence);
      emit(evidence);
    }
    return result;
  }
  return {
    agentId: 'workbuddy',
    capabilities: WORKBUDDY_MANIFEST.capabilities,
    collect(events, options = {}) { return collect(events, hookEventToEvidence, options); },
    collectEvidence(events, options = {}) { return collect(events, hookEventToEvidence, options); },
    collectHeartbeats(events, options = {}) { return collect(events, heartbeatToEvidence, options); },
    collectDatabaseStatuses(events, options = {}) { return collect(events, databaseStatusToEvidence, options); },
  };
}

module.exports = { createWorkBuddyStateAdapter, hookEventToEvidence, heartbeatToEvidence, databaseStatusToEvidence };
