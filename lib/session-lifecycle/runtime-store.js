'use strict';

const { createSessionLifecycleEngine } = require('./engine');

function createRuntimeStore(options = {}) {
  const engines = new Map();
  function get(sessionRef) {
    const key = String(sessionRef || '');
    if (!engines.has(key)) engines.set(key, createSessionLifecycleEngine(options));
    return engines.get(key);
  }
  return {
    get,
    clear() { engines.clear(); },
    ingest(sessionRef, event) { return get(sessionRef).ingest(event); },
    snapshot(sessionRef) { return get(sessionRef).getState(); },
    entries() { return [...engines.entries()].map(([sessionRef, engine]) => [sessionRef, engine.getState()]); },
  };
}

module.exports = { createRuntimeStore };
