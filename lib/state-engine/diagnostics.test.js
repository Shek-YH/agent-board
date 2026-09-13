'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { EVENT_TYPES } = require('./enums');
const { createInitialRuntime } = require('./runtime');
const { reduceEvidence } = require('./reducer');
const { buildStatusDiagnostics, buildDiagnosticBundle } = require('./diagnostics');

function evidence(id, signalType, timestamp, value = {}) {
  return {
    evidenceId: id,
    agent: 'codex', sessionRef: 'codex:diagnostic-session', source: 'jsonl', signalType,
    value, occurredAt: timestamp, observedAt: timestamp, confidence: 0.99, authority: 90,
  };
}

function runtime() {
  let result = createInitialRuntime({ sessionRef: 'codex:diagnostic-session' });
  result = reduceEvidence(result, evidence('start', EVENT_TYPES.TURN_STARTED, 100, { turnId: 'turn-1' }));
  result = reduceEvidence(result, evidence('complete', EVENT_TYPES.TURN_COMPLETION_SIGNAL, 200, { turnId: 'turn-1', command: 'private' }));
  return result;
}

test('status diagnostics explain canonical state with sanitized winning evidence', () => {
  const result = buildStatusDiagnostics(runtime(), {
    now: 250,
    sourceHealth: { jsonl: 'HEALTHY', ui: 'DEGRADED' },
    conflicts: [{ dimension: 'activityState', evidenceId: 'ui-1', reason: 'lower_authority', value: 'drop-me' }],
  });

  assert.match(result.diagnosticId, /^AB-STATE-19700101-/);
  assert.equal(result.canonical.turnState, 'COMPLETION_CANDIDATE');
  assert.equal(result.canonical.sessionLifecycle, 'OPEN');
  assert.equal(result.winningEvidence.turnState.evidenceId, 'complete');
  assert.equal(result.winningEvidence.turnState.signalType, EVENT_TYPES.TURN_COMPLETION_SIGNAL);
  assert.equal(result.sourceHealth.jsonl, 'HEALTHY');
  assert.equal(result.sourceHealth.ui, 'DEGRADED');
  assert.equal(result.conflictCount, 1);
  assert.equal(JSON.stringify(result).includes('private'), false);
  assert.equal(JSON.stringify(result).includes('value'), false);
});

test('diagnostic bundle contains timeline and safe identity metadata but never raw evidence values', () => {
  const input = runtime();
  const result = buildDiagnosticBundle(input, {
    now: 300,
    adapterCapabilities: { jsonl: true, process: true },
  });

  assert.equal(result.manifest.schemaVersion, 1);
  assert.equal(result.sessionRef, input.sessionRef);
  assert.equal(result.timeline.length, 2);
  assert.deepEqual(result.timeline[0], {
    evidenceId: 'start', source: 'jsonl', signalType: EVENT_TYPES.TURN_STARTED,
    occurredAt: 100, observedAt: 100, confidence: 0.99, authority: 90,
  });
  assert.deepEqual(result.adapterCapabilities, { jsonl: true, process: true });
  assert.equal(Object.hasOwn(result.timeline[0], 'value'), false);
});
