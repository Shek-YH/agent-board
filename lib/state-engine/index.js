'use strict';

const { normalizeEvidence } = require('./evidence');
const { createInitialRuntime } = require('./runtime');
const { cloneRuntime } = require('./runtime');
const { acceptEvidence, createSourceWatermarks } = require('./source-watermark');
const { reduceEvidence } = require('./reducer');
const { projectStatus, resolveStateEngineMode } = require('./projection');
const { createStateEnginePersistence } = require('./persistence');
const { ACTIVITY_STATES, ATTENTION_STATES, LIVENESS_STATES, TURN_STATES } = require('./enums');
const { createCompletionId, markCompletionNotified } = require('./completion');
const { createProcessLivenessService } = require('./liveness');

function createStateEngine(options = {}) {
  const mode = resolveStateEngineMode(options.mode);
  const runtimes = new Map();
  const watermarks = new Map();
  const onCompletion = typeof options.onCompletion === 'function' ? options.onCompletion : (_event) => {};
  const persistence = options.persistence || (options.persistencePath
    ? createStateEnginePersistence({ filePath: options.persistencePath }) : null);
  const processLiveness = createProcessLivenessService(options.liveness || {});

  function restore() {
    if (mode === 'off' || !persistence) return;
    const snapshot = persistence.load();
    if (!snapshot) return;
    for (const item of snapshot.sessions) {
      try {
        const runtime = createInitialRuntime(item.runtime);
        const safeRuntime = runtime.turnState === TURN_STATES.RUNNING || runtime.turnState === TURN_STATES.STARTING
          ? cloneRuntime(runtime, {
            liveness: LIVENESS_STATES.UNKNOWN,
            turnState: TURN_STATES.NONE,
            activityState: ACTIVITY_STATES.UNKNOWN,
            attentionState: ATTENTION_STATES.NONE,
            activeToolIds: [],
            activeSubagentIds: [],
            recentEvidence: [],
          })
          : cloneRuntime(runtime, { liveness: LIVENESS_STATES.UNKNOWN, recentEvidence: [] });
        runtimes.set(safeRuntime.sessionRef, safeRuntime);
        watermarks.set(safeRuntime.sessionRef, createSourceWatermarks(item.watermark));
      } catch {
        // Ignore one malformed session while preserving other valid snapshots.
      }
    }
  }

  function persist() {
    if (mode === 'off' || !persistence) return;
    persistence.save({ sessions: [...runtimes.entries()].map(([sessionRef, runtime]) => ({
      runtime,
      watermark: getWatermark(sessionRef),
    })) });
  }

  function getWatermark(sessionRef) {
    return watermarks.get(String(sessionRef || '')) || createSourceWatermarks();
  }

  function ingest(input) {
    if (mode === 'off') return { accepted: false, reason: 'feature_disabled', runtime: null };
    const evidence = normalizeEvidence(input);
    const sessionRef = evidence.sessionRef;
    const watermarkResult = acceptEvidence(getWatermark(sessionRef), evidence);
    watermarks.set(sessionRef, watermarkResult.state);
    const current = runtimes.get(sessionRef) || createInitialRuntime({
      sessionRef,
      identity: { agent: evidence.agent, nativeSessionId: evidence.nativeSessionId },
    });
    if (!watermarkResult.accepted) {
      return { accepted: false, reason: watermarkResult.reason, evidence, runtime: current };
    }
    let runtime = reduceEvidence(current, evidence);
    if (current.turnState !== TURN_STATES.COMPLETED && runtime.turnState === TURN_STATES.COMPLETED && runtime.currentTurnId) {
      const completionId = createCompletionId({
        agent: runtime.identity.agent,
        runtimeSessionKey: runtime.runtimeSessionKey,
        turnId: runtime.currentTurnId,
        completedAt: evidence.occurredAt,
      });
      const notification = markCompletionNotified(runtime, completionId);
      runtime = notification.runtime;
      if (notification.notified) {
        onCompletion({
          completionId,
          runtime: {
            sessionRef: runtime.sessionRef,
            runtimeSessionKey: runtime.runtimeSessionKey,
            liveness: runtime.liveness,
            sessionLifecycle: runtime.sessionLifecycle,
            turnState: runtime.turnState,
            activityState: runtime.activityState,
            attentionState: runtime.attentionState,
            currentTurnId: runtime.currentTurnId,
            updatedAt: runtime.updatedAt,
          },
        });
      }
    }
    runtimes.set(sessionRef, runtime);
    try { persist(); } catch { /* persistence failure must not turn valid runtime evidence into a product failure */ }
    return { accepted: true, evidence, runtime };
  }

  function observeProcess(input) {
    if (mode === 'off') return { accepted: false, reason: 'feature_disabled', runtime: null };
    const observation = processLiveness.observe(input);
    const result = ingest(observation.evidence);
    return { ...result, livenessState: observation.state };
  }

  restore();

  return {
    mode,
    ingest,
    observeProcess,
    ingestMany(inputs) {
      return (Array.isArray(inputs) ? inputs : []).map((input) => ingest(input));
    },
    get(sessionRef) { return runtimes.get(String(sessionRef || '')) || null; },
    snapshot(sessionRef) { return runtimes.get(String(sessionRef || '')) || null; },
    entries() { return [...runtimes.entries()].map(([sessionRef, runtime]) => [sessionRef, runtime]); },
    project(sessionRef) {
      const runtime = runtimes.get(String(sessionRef || ''));
      return runtime ? projectStatus(runtime, mode) : null;
    },
    getWatermark,
    getSourceHealth() { return processLiveness.getSourceHealth(); },
    persist,
    clear() { runtimes.clear(); watermarks.clear(); },
  };
}

module.exports = { createStateEngine };
