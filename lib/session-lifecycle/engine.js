'use strict';

const { applyEvent, initialState } = require('./reducer');
const { selectRuntimeSnapshot } = require('./selectors');

function createSessionLifecycleEngine(options = {}) {
  const clock = typeof options.clock === 'function' ? options.clock : Date.now;
  const stabilizationMs = Math.max(0, Number(options.stabilizationMs ?? 5000));
  let state = initialState(options.initialState);

  function ingest(event) {
    const before = state;
    state = applyEvent(state, event);
    return { changed: state !== before, state: selectRuntimeSnapshot(state) };
  }

  function advance(now = clock()) {
    if (state.publicState !== 'COMPLETION_CANDIDATE' || now < state.completionCandidateAt + stabilizationMs) {
      return { changed: false, state: selectRuntimeSnapshot(state) };
    }
    return ingest({
      schemaVersion: 1,
      eventId: `completion-confirmed:${state.completionCandidateAt}`,
      agent: 'lifecycle',
      sessionRef: 'lifecycle:internal',
      timestamp: now,
      type: 'COMPLETION_CONFIRMED',
      source: 'lifecycle_engine',
    });
  }

  return {
    ingest,
    advance,
    getState: () => selectRuntimeSnapshot(state),
    getInternalState: () => initialState(state),
  };
}

module.exports = { createSessionLifecycleEngine };
