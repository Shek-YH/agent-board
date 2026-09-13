'use strict';

const { createCodexStateAdapter } = require('../agent-adapters/codex-state-adapter');
const { createWorkBuddyStateAdapter } = require('../agent-adapters/workbuddy-state-adapter');
const { createStateEngine } = require('./index');
const { projectLegacyState, projectStatus, projectUiStatus } = require('./projection');

function createStateEngineStoreBridge(options = {}) {
  const engine = createStateEngine(options);
  let lastResult = null;
  const codexAdapter = createCodexStateAdapter({
    mode: engine.mode,
    emit: (evidence) => { lastResult = engine.ingest(evidence); },
  });
  const workbuddyAdapter = createWorkBuddyStateAdapter({
    mode: engine.mode,
    emit: (evidence) => { lastResult = engine.ingest(evidence); },
  });

  function collect(adapterMethod, item, ingestOptions) {
    lastResult = null;
    adapterMethod([item], ingestOptions);
    return lastResult || {
      accepted: false,
      reason: engine.mode === 'off' ? 'feature_disabled' : 'unsupported_event',
      runtime: null,
    };
  }

  function ingest(event, ingestOptions = {}) {
    if (engine.mode === 'off') return { accepted: false, reason: 'feature_disabled', runtime: null };
    return collect(
      codexAdapter.collect.bind(codexAdapter),
      event,
      { observedAt: ingestOptions.observedAt ?? event?.observedAt ?? event?.ts },
    );
  }

  function ingestMany(events, ingestOptions = {}) {
    return (Array.isArray(events) ? events : []).map((event) => ingest(event, ingestOptions));
  }

  return {
    mode: engine.mode,
    engine,
    ingest,
    ingestMany,
    ingestWorkBuddy(event, ingestOptions = {}) {
      if (engine.mode === 'off') return { accepted: false, reason: 'feature_disabled', runtime: null };
      return collect(
        workbuddyAdapter.collect.bind(workbuddyAdapter),
        event,
        { observedAt: ingestOptions.observedAt ?? event?.observedAt ?? event?.ts },
      );
    },
    ingestWorkBuddyHeartbeat(event, ingestOptions = {}) {
      if (engine.mode === 'off') return { accepted: false, reason: 'feature_disabled', runtime: null };
      return collect(
        workbuddyAdapter.collectHeartbeats.bind(workbuddyAdapter),
        event,
        { observedAt: ingestOptions.observedAt ?? event?.observedAt ?? event?.lastHeartbeat },
      );
    },
    ingestWorkBuddyDatabase(event, ingestOptions = {}) {
      if (engine.mode === 'off') return { accepted: false, reason: 'feature_disabled', runtime: null };
      return collect(
        workbuddyAdapter.collectDatabaseStatuses.bind(workbuddyAdapter),
        event,
        { observedAt: ingestOptions.observedAt ?? event?.observedAt ?? event?.statusAt },
      );
    },
    getStatus(sessionRef) {
      const runtime = engine.get(sessionRef);
      if (!runtime) return null;
      const ui = projectUiStatus(runtime);
      const projected = projectStatus(runtime, engine.mode);
      return {
        sessionRef: runtime.sessionRef,
        runtimeSessionKey: runtime.runtimeSessionKey,
        mode: engine.mode,
        source: projected.source,
        state: projected.state,
        legacy_state: projectLegacyState(runtime),
        canonical_state: ui.canonical,
        ui_status: ui,
      };
    },
  };
}

module.exports = { createStateEngineStoreBridge };
