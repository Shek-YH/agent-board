'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { EVENT_TYPES, LIVENESS_STATES, SOURCE_HEALTH_STATES } = require('./enums');
const { createProcessLivenessService } = require('./liveness');

test('exact process observation produces liveness Evidence without activity semantics', () => {
  const service = createProcessLivenessService({ deadAfterMisses: 3 });
  const result = service.observe({ agent: 'codex', sessionRef: 'codex:session-1', processId: 42, processStartedAt: 100, alive: true, identityMatched: true, observedAt: 200 });

  assert.equal(result.state, LIVENESS_STATES.ALIVE);
  assert.equal(result.evidence.signalType, EVENT_TYPES.PROCESS_SEEN);
  assert.equal(result.evidence.source, 'process');
  assert.equal(result.evidence.value.identityConfirmed, true);
  assert.equal(result.evidence.value.processId, 42);
  assert.equal(service.get('codex:session-1').state, LIVENESS_STATES.ALIVE);
});

test('temporary process misses debounce to SUSPECT and only reach DEAD at the configured threshold', () => {
  const service = createProcessLivenessService({ deadAfterMisses: 3, deadAfterMs: 6000 });
  service.observe({ agent: 'codex', sessionRef: 'codex:session-2', alive: true, identityMatched: true, observedAt: 100 });
  const first = service.observe({ agent: 'codex', sessionRef: 'codex:session-2', alive: false, identityMatched: true, observedAt: 200 });
  const second = service.observe({ agent: 'codex', sessionRef: 'codex:session-2', alive: false, identityMatched: true, observedAt: 300 });
  const third = service.observe({ agent: 'codex', sessionRef: 'codex:session-2', alive: false, identityMatched: true, observedAt: 6200 });

  assert.equal(first.state, LIVENESS_STATES.SUSPECT);
  assert.equal(second.state, LIVENESS_STATES.SUSPECT);
  assert.equal(third.state, LIVENESS_STATES.DEAD);
  assert.equal(third.evidence.signalType, EVENT_TYPES.PROCESS_DEAD);
});

test('unmatched process identity remains UNKNOWN and source health is bounded', () => {
  const service = createProcessLivenessService();
  const result = service.observe({ agent: 'codex', sessionRef: 'codex:session-3', alive: true, identityMatched: false, observedAt: 100 });
  service.setSourceHealth('process', SOURCE_HEALTH_STATES.DEGRADED);

  assert.equal(result.state, LIVENESS_STATES.UNKNOWN);
  assert.equal(result.evidence.value.identityConfirmed, false);
  assert.deepEqual(service.getSourceHealth(), { process: SOURCE_HEALTH_STATES.DEGRADED });
  assert.equal(JSON.stringify(service.getSourceHealth()).includes('session-3'), false);
});
