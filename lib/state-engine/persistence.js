'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_VERSION = 1;
const RUNTIME_FIELDS = [
  'sessionRef', 'runtimeSessionKey', 'identity', 'liveness', 'sessionLifecycle',
  'turnState', 'activityState', 'attentionState', 'currentTurnId',
  'lastActivityAt', 'lastEvidenceAt', 'lastStrongEvidenceAt', 'activeToolIds',
  'activeSubagentIds', 'winningEvidence', 'confidence', 'updatedAt',
  'completionNotificationIds',
];
const IDENTITY_FIELDS = [
  'agent', 'hostId', 'nativeSessionId', 'processId', 'processStartedAt',
  'terminalInstanceId', 'terminalTTY', 'workspaceId', 'cwd', 'transcriptPath',
  'transcriptFileId', 'generation',
];

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
}

function serializeRuntime(runtime) {
  const result = {};
  for (const field of RUNTIME_FIELDS) {
    if (field === 'identity') continue;
    if (runtime[field] !== undefined) result[field] = clone(runtime[field]);
  }
  result.identity = Object.fromEntries(IDENTITY_FIELDS
    .filter((field) => runtime.identity && runtime.identity[field] !== undefined)
    .map((field) => [field, clone(runtime.identity[field])]));
  result.activeToolIds = Array.isArray(result.activeToolIds) ? result.activeToolIds.map(String) : [];
  result.activeSubagentIds = Array.isArray(result.activeSubagentIds) ? result.activeSubagentIds.map(String) : [];
  result.completionNotificationIds = Array.isArray(result.completionNotificationIds)
    ? result.completionNotificationIds.map(String).slice(-4096) : [];
  return result;
}

function serializeWatermark(watermark = {}) {
  const sources = {};
  for (const [key, item] of Object.entries(watermark.sources || {})) {
    sources[String(key)] = {
      generation: item.generation ?? null,
      lastSequence: item.lastSequence ?? null,
      lastOffset: item.lastOffset ?? null,
      lastObservedAt: item.lastObservedAt ?? null,
    };
  }
  return {
    sources,
    acceptedEvidenceIds: Array.isArray(watermark.acceptedEvidenceIds)
      ? watermark.acceptedEvidenceIds.map(String).slice(-4096) : [],
  };
}

function validateSnapshot(snapshot) {
  if (!snapshot || snapshot.schemaVersion !== SCHEMA_VERSION || !Array.isArray(snapshot.sessions)) return null;
  if (snapshot.sessions.some((item) => !item || typeof item !== 'object' || !item.runtime || !item.runtime.sessionRef)) return null;
  return {
    schemaVersion: SCHEMA_VERSION,
    savedAt: Number(snapshot.savedAt) || 0,
    sessions: snapshot.sessions.map((item) => ({
      runtime: clone(item.runtime),
      watermark: serializeWatermark(item.watermark),
    })),
  };
}

/** @param {{filePath?: string}} options */
function createStateEnginePersistence({ filePath } = {}) {
  const target = String(filePath || '').trim();
  if (!target) throw new TypeError('filePath is required');
  const temporary = `${target}.${process.pid}.tmp`;

  return {
    filePath: target,
    save({ sessions = [] } = {}) {
      if (!Array.isArray(sessions)) throw new TypeError('sessions must be an array');
      const payload = {
        schemaVersion: SCHEMA_VERSION,
        savedAt: Date.now(),
        sessions: sessions.map((item) => ({
          runtime: serializeRuntime(item.runtime || {}),
          watermark: serializeWatermark(item.watermark),
        })),
      };
      fs.mkdirSync(path.dirname(target), { recursive: true });
      try {
        fs.writeFileSync(temporary, JSON.stringify(payload), 'utf8');
        fs.renameSync(temporary, target);
      } catch (error) {
        try { fs.unlinkSync(temporary); } catch { /* best effort cleanup of own temp */ }
        throw error;
      }
    },
    load() {
      if (!fs.existsSync(target)) return null;
      try {
        return validateSnapshot(JSON.parse(fs.readFileSync(target, 'utf8')));
      } catch {
        return null;
      }
    },
  };
}

module.exports = { SCHEMA_VERSION, createStateEnginePersistence, serializeRuntime, serializeWatermark };
