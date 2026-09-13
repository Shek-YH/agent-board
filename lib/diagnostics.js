'use strict';

const DIAGNOSTIC_KINDS = new Set(['transition', 'scan', 'storage', 'sse']);
const MAX_STRING = 80;
const MAX_ENTRIES = 500;

function safeString(value) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, MAX_STRING) : null;
}

function safeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function sanitizeDiagnostic(input) {
  const value = input && typeof input === 'object' ? input : {};
  const result = {};
  const kind = safeString(value.kind);
  if (kind && DIAGNOSTIC_KINDS.has(kind)) result.kind = kind;
  for (const field of ['component', 'action', 'status', 'code', 'eventId']) {
    const safe = safeString(value[field]);
    if (safe) result[field] = safe;
  }
  for (const field of ['count', 'durationMs', 'seq']) {
    const safe = safeNumber(value[field]);
    if (safe !== null) result[field] = safe;
  }
  return result;
}

function createDiagnostics({ maxEntries = 200, now = Date.now } = {}) {
  const limit = Math.min(MAX_ENTRIES, Math.max(1, Math.floor(Number(maxEntries) || 1)));
  const entries = [];
  let total = 0;

  return {
    record(input) {
      const entry = { id: String(++total), at: Number(now()), ...sanitizeDiagnostic(input) };
      entries.push(entry);
      if (entries.length > limit) entries.shift();
      return entry;
    },
    snapshot() {
      return entries.map((entry) => ({ ...entry }));
    },
    summary() {
      const last = entries.at(-1);
      return {
        retained: entries.length,
        total,
        lastKind: last?.kind || null,
        lastStatus: last?.status || null,
      };
    },
  };
}

module.exports = { createDiagnostics, sanitizeDiagnostic };
