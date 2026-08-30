'use strict';

const fs = require('node:fs');
const { normalizeEvent } = require('./workbuddy-monitor');
const { fileSignature, readAll } = require('./watcher');

const DEFAULT_MAX_READ_BYTES = 1024 * 1024;
const MAX_SEEN_EVENTS = 8192;

function metaValue(store, key) {
  try { return store?.stmts?.getMeta?.get(key)?.v; } catch { return undefined; }
}

function setMetaValue(store, key, value) {
  try { store?.stmts?.setMeta?.run(key, String(value)); } catch { /* best effort */ }
}

function eventIdentity(event) {
  if (event && typeof event.event_id === 'string' && event.event_id) return event.event_id;
  const normalized = normalizeEvent(event, () => Number(event?.ts) || 0);
  if (!normalized.diagnostic) return normalized.event_id;
  return JSON.stringify([
    event?.event,
    event?.ts,
    event?.session_id,
    event?.tool_use_id,
    event?.subagent_id,
    event?.task_id,
  ]);
}

function createSpoolReader({ spoolPaths = [], maxReadBytes = DEFAULT_MAX_READ_BYTES } = {}) {
  const paths = [...new Set(spoolPaths.filter((value) => typeof value === 'string' && value))];
  const cursors = new Map();
  const seenEvents = new Set();
  const seenEventOrder = [];

  function cursorKeys(filePath) {
    return {
      identity: `workbuddy-spool-v1:file-id:${filePath}`,
      offset: `workbuddy-spool-v1:offset:${filePath}`,
      size: `workbuddy-spool-v1:file-size:${filePath}`,
    };
  }

  function readPath(filePath, store) {
    const signature = fileSignature(filePath);
    if (!signature) return [];
    const keys = cursorKeys(filePath);
    const local = cursors.get(filePath) || {};
    const storedIdentity = metaValue(store, keys.identity) || local.identity || '';
    const storedOffset = Number(metaValue(store, keys.offset) ?? local.offset ?? 0) || 0;
    const storedSize = Number(metaValue(store, keys.size) ?? local.size ?? 0) || 0;
    const truncated = storedSize > 0 && signature.size < storedSize;
    const offset = (storedIdentity && storedIdentity !== signature.identity) || truncated || signature.size < storedOffset
      ? 0
      : storedOffset;
    const result = readAll(filePath, offset, maxReadBytes);
    cursors.set(filePath, { identity: signature.identity, offset: result.newOffset, size: signature.size });
    setMetaValue(store, keys.identity, signature.identity);
    setMetaValue(store, keys.offset, result.newOffset);
    setMetaValue(store, keys.size, signature.size);
    return result.lines;
  }

  function remember(identity) {
    if (seenEvents.has(identity)) return false;
    seenEvents.add(identity);
    seenEventOrder.push(identity);
    if (seenEventOrder.length > MAX_SEEN_EVENTS) seenEvents.delete(seenEventOrder.shift());
    return true;
  }

  function read(store) {
    const events = [];
    // .1 是旧文件，先读它可保证轮转边界的事件顺序；identity + event id 会阻止重放。
    for (const filePath of [...paths].sort((left, right) => Number(right.endsWith('.1')) - Number(left.endsWith('.1')))) {
      for (const event of readPath(filePath, store)) {
        if (remember(eventIdentity(event))) events.push(event);
      }
    }
    events.sort((left, right) => {
      const leftTs = Number(left?.ts);
      const rightTs = Number(right?.ts);
      return (Number.isFinite(leftTs) ? leftTs : Number.MAX_SAFE_INTEGER)
        - (Number.isFinite(rightTs) ? rightTs : Number.MAX_SAFE_INTEGER);
    });
    return { events, readable: paths.some((filePath) => Boolean(fileSignature(filePath))) };
  }

  function reset() {
    cursors.clear();
    seenEvents.clear();
    seenEventOrder.length = 0;
  }

  return { read, reset, paths: [...paths] };
}

module.exports = {
  DEFAULT_MAX_READ_BYTES,
  createSpoolReader,
};
