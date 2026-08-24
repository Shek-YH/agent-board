'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch { /* Node versions without node:sqlite use the JSONL fallback. */ }

const DEFAULT_DB_PATH = path.join(os.homedir(), '.workbuddy', 'workbuddy.db');
const TERMINAL_STATUSES = new Set(['completed', 'terminated', 'error', 'failed', 'cancelled', 'canceled']);
const ACTIVE_STATUSES = new Set(['pending', 'queued', 'running', 'working', 'active', 'in_progress', 'processing']);

function timestampOf(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function normalizeSessionStatus(row) {
  const status = String(row && row.status || '').trim().toLowerCase();
  const deleted = row && row.deleted_at !== null && row.deleted_at !== undefined;
  return {
    sessionId: String(row && row.id || ''),
    status,
    statusAt: Math.max(timestampOf(row && row.updated_at), timestampOf(row && row.last_activity_at)),
    terminal: deleted || TERMINAL_STATUSES.has(status),
    active: !deleted && ACTIVE_STATUSES.has(status),
  };
}

function createStatusReader({ dbPath = DEFAULT_DB_PATH } = {}) {
  let db = null;
  let statement = null;

  function close() {
    if (db) {
      try { db.close(); } catch { /* ignore */ }
    }
    db = null;
    statement = null;
  }

  function read() {
    if (!DatabaseSync || !fs.existsSync(dbPath)) return new Map();
    try {
      if (!db) {
        db = new DatabaseSync(dbPath, { readOnly: true });
        statement = db.prepare(
          'SELECT id, status, updated_at, last_activity_at, deleted_at FROM sessions'
        );
      }
      const result = new Map();
      for (const row of statement.all()) {
        const status = normalizeSessionStatus(row);
        if (status.sessionId) result.set(status.sessionId, status);
      }
      return result;
    } catch {
      // WorkBuddy may replace/checkpoint the database while it is being read.
      // Close the handle so the next poll can reopen the latest file.
      close();
      return new Map();
    }
  }

  return { read, close };
}

module.exports = {
  DEFAULT_DB_PATH,
  normalizeSessionStatus,
  createStatusReader,
};
