'use strict';

const { normalizeEvidence } = require('./evidence');

const DEFAULT_COALESCE_SOURCES = Object.freeze(new Set(['heartbeat', 'process']));

function createEvidenceQueue(options = {}) {
  const maxSize = Number(options.maxSize ?? 2048);
  if (!Number.isInteger(maxSize) || maxSize < 1) throw new TypeError('maxSize must be a positive integer');
  const coalesceSources = new Set(options.coalesceSources || DEFAULT_COALESCE_SOURCES);
  const items = [];

  function keyOf(evidence) {
    return `${evidence.agent}:${evidence.sessionRef}:${evidence.source}`;
  }

  function push(input) {
    const evidence = normalizeEvidence(input);
    if (coalesceSources.has(evidence.source)) {
      const key = keyOf(evidence);
      for (let index = items.length - 1; index >= 0; index -= 1) {
        if (keyOf(items[index]) !== key) continue;
        items[index] = evidence;
        return { accepted: true, coalesced: true, evidence };
      }
    }
    if (items.length >= maxSize) {
      const removable = items.findIndex((item) => coalesceSources.has(item.source));
      if (removable < 0) return { accepted: false, coalesced: false, reason: 'queue_full', evidence };
      items.splice(removable, 1);
    }
    items.push(evidence);
    return { accepted: true, coalesced: false, evidence };
  }

  return {
    push,
    drain() { return items.splice(0, items.length); },
    size() { return items.length; },
    maxSize,
  };
}

module.exports = { DEFAULT_COALESCE_SOURCES, createEvidenceQueue };
