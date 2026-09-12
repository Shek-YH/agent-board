'use strict';

const fs = require('node:fs');
const { readAll } = require('./watcher');

const SINGLE_TURN_HOLD_MS = 5 * 1000;
const MULTI_TURN_DEFAULT_HOLD_MS = 10 * 1000;
const RAPID_CONTINUATION_MAX_MS = 180 * 1000;
const COMPLETION_BUFFER_MS = 6 * 1000;
const MAX_PREDICTED_HOLD_MS = 60 * 1000;
const MAX_HISTORY_EVENTS = 4096;

function eventTime(event) {
  if (Number.isFinite(event && event.ts)) return event.ts;
  return Date.parse(event && event.timestamp) || 0;
}

function lifecycleType(event) {
  return event && event.type === 'event_msg' ? event.payload && event.payload.type : '';
}

function eventKey(event, type, ts) {
  return `${type}:${ts}:${event && event.payload && event.payload.turn_id || ''}`;
}

function rapidGaps(starts, completes) {
  const orderedStarts = starts.map((item) => item.ts).sort((a, b) => a - b);
  const orderedCompletes = completes.map((item) => item.ts).sort((a, b) => a - b);
  const gaps = [];
  for (const complete of orderedCompletes) {
    const nextStart = orderedStarts.find((start) => start > complete);
    if (!nextStart) continue;
    const gap = nextStart - complete;
    if (gap >= 0 && gap <= RAPID_CONTINUATION_MAX_MS) gaps.push(gap);
  }
  return gaps;
}

function holdMs(starts, completes, signalTs) {
  const signal = Number(signalTs) || 0;
  const filteredStarts = starts.filter((item) => item.ts <= signal);
  if (filteredStarts.length <= 1) return SINGLE_TURN_HOLD_MS;
  const filteredCompletes = completes.filter((item) => item.ts <= signal);
  const gaps = rapidGaps(filteredStarts, filteredCompletes);
  if (!gaps.length) return MULTI_TURN_DEFAULT_HOLD_MS;
  return Math.min(MAX_PREDICTED_HOLD_MS, Math.max(
    MULTI_TURN_DEFAULT_HOLD_MS,
    Math.max(...gaps) + COMPLETION_BUFFER_MS,
  ));
}

function normalizeStat(value) {
  if (!value) return null;
  const identity = value.identity || [value.dev, value.ino, value.birthtimeMs]
    .map((item) => Number.isFinite(item) ? item : '').join(':');
  return { identity, size: Number(value.size) || 0 };
}

function createState(stat) {
  return {
    fileIdentity: stat && stat.identity || '',
    lastOffset: stat && stat.size || 0,
    starts: [],
    completes: [],
    seen: new Set(),
  };
}

function observe(state, lines) {
  for (const event of Array.isArray(lines) ? lines : []) {
    const type = lifecycleType(event);
    if (type !== 'task_started' && type !== 'task_complete') continue;
    const ts = eventTime(event);
    if (!ts) continue;
    const key = eventKey(event, type, ts);
    if (state.seen.has(key)) continue;
    state.seen.add(key);
    const target = type === 'task_started' ? state.starts : state.completes;
    target.push({ ts, key });
    if (target.length > MAX_HISTORY_EVENTS) {
      const removed = target.shift();
      state.seen.delete(removed.key);
    }
  }
}

function createCompletionHistory(options = {}) {
  const stat = typeof options.stat === 'function' ? options.stat : (filePath) => {
    try { return fs.statSync(filePath); } catch { return null; }
  };
  const rebuild = typeof options.readAll === 'function' ? options.readAll : readAll;
  const cache = new Map();

  function ensure(filePath, fallbackLines) {
    const current = normalizeStat(stat(filePath));
    let state = cache.get(filePath);
    const invalid = !state
      || (current && current.identity && state.fileIdentity !== current.identity)
      || (current && current.size < state.lastOffset);
    if (invalid) {
      state = createState(current);
      cache.set(filePath, state);
      try {
        const rebuilt = rebuild(filePath, 0);
        observe(state, rebuilt && rebuilt.lines);
      } catch { /* 文件刚被删除或重建时使用当前批次 */ }
    }
    observe(state, fallbackLines);
    if (current) {
      state.fileIdentity = current.identity;
      state.lastOffset = current.size;
    }
    return state;
  }

  return {
    holdMs(filePath, signalTs, fallbackLines) {
      const state = ensure(filePath, fallbackLines);
      return holdMs(state.starts, state.completes, signalTs);
    },
    snapshot(filePath) {
      const state = cache.get(filePath);
      if (!state) return null;
      return {
        fileIdentity: state.fileIdentity,
        lastOffset: state.lastOffset,
        startCount: state.starts.length,
        completeCount: state.completes.length,
        starts: state.starts.map((item) => item.ts),
        recentRapidGaps: rapidGaps(state.starts, state.completes),
      };
    },
  };
}

module.exports = { createCompletionHistory, completionHoldMs: holdMs };
