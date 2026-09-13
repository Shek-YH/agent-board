'use strict';

const { normalizeEvidence } = require('./evidence');
const { createInitialRuntime } = require('./runtime');
const { reduceEvidence } = require('./reducer');

function canonical(runtime) {
  return {
    liveness: runtime.liveness,
    sessionLifecycle: runtime.sessionLifecycle,
    turnState: runtime.turnState,
    activityState: runtime.activityState,
    attentionState: runtime.attentionState,
  };
}

function replay(inputs, options = {}) {
  if (!Array.isArray(inputs)) throw new TypeError('replay evidence must be an array');
  const first = inputs.length ? normalizeEvidence(inputs[0]) : null;
  let runtime = options.initialRuntime;
  const sessionRef = String(options.sessionRef || runtime?.sessionRef || first?.sessionRef || '').trim();
  if (!sessionRef) throw new TypeError('replay requires sessionRef or evidence');
  if (!runtime) {
    runtime = createInitialRuntime({
      sessionRef,
      identity: first ? { agent: first.agent, nativeSessionId: first.nativeSessionId } : undefined,
    });
  }
  if (runtime.sessionRef !== sessionRef) throw new TypeError('initial runtime sessionRef does not match replay');

  const trace = [];
  for (const input of inputs) {
    const evidence = normalizeEvidence(input);
    if (evidence.sessionRef !== sessionRef) throw new TypeError('replay evidence sessionRef does not match runtime');
    const before = runtime;
    runtime = reduceEvidence(runtime, evidence);
    trace.push({ evidenceId: evidence.evidenceId, changed: runtime !== before, canonical: canonical(runtime) });
  }
  return { runtime, trace };
}

module.exports = { replay };
