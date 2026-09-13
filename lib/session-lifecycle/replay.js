'use strict';

const { EVENT_TYPES } = require('./events');

const SUPPORTED_AGENTS = new Set(['codex', 'workbuddy']);

function refFor(entry) {
  const ref = String(entry && entry.ref || '');
  if (ref) return ref;
  const agent = String(entry && entry.agent || '');
  const sessionId = String(entry && (entry.sessionId || entry.session_id) || '');
  return agent && sessionId ? `${agent}:${sessionId}` : '';
}

function sessionTimestamp(sessions, ref) {
  const session = sessions.find((item) => String(item && item.id || '') === ref);
  return Math.max(1, Number(session && (session.last_seen || session.lastSeen)) || 0);
}

/** @param {{ingest: Function}} runtime @param {Record<string, any>} snapshot */
function replayLifecycleSnapshot(runtime, snapshot = {}) {
  if (!runtime || !snapshot || typeof snapshot !== 'object') return { restored: 0 };
  const sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
  let restored = 0;
  const manualRefs = new Set();
  for (const entry of Array.isArray(snapshot.manualStatus) ? snapshot.manualStatus : []) {
    const ref = refFor(entry);
    if (!SUPPORTED_AGENTS.has(ref.split(':')[0]) || entry.status !== 'done') continue;
    manualRefs.add(ref);
    runtime.ingest(ref, {
      schemaVersion: 1,
      eventId: `replay:manual:${ref}`,
      agent: ref.split(':')[0],
      sessionId: ref.slice(ref.indexOf(':') + 1),
      sessionRef: ref,
      timestamp: sessionTimestamp(sessions, ref),
      type: EVENT_TYPES.MANUAL_COMPLETED,
      source: 'snapshot_replay',
    });
    restored += 1;
  }
  for (const entry of Array.isArray(snapshot.doneSignalAt) ? snapshot.doneSignalAt : []) {
    const ref = refFor(entry);
    const timestamp = Number(entry && entry.ts) || 0;
    if (!SUPPORTED_AGENTS.has(ref.split(':')[0]) || !timestamp || manualRefs.has(ref)) continue;
    runtime.ingest(ref, {
      schemaVersion: 1,
      eventId: `replay:done:${ref}:${timestamp}`,
      agent: ref.split(':')[0],
      sessionId: ref.slice(ref.indexOf(':') + 1),
      sessionRef: ref,
      timestamp,
      type: EVENT_TYPES.COMPLETION_CONFIRMED,
      source: 'snapshot_replay',
    });
    restored += 1;
  }
  return { restored };
}

module.exports = { replayLifecycleSnapshot };
