'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { EVENT_TYPES } = require('./enums');
const { createEvidenceQueue } = require('./queue');

function evidence(id, source, signalType, observedAt) {
  return {
    evidenceId: id, agent: 'codex', sessionRef: 'codex:queue-session', source, signalType,
    value: {}, occurredAt: observedAt, observedAt, confidence: 0.9, authority: source === 'heartbeat' ? 75 : 90,
  };
}

test('queue coalesces high-frequency heartbeat evidence by source/session', () => {
  const queue = createEvidenceQueue({ maxSize: 4 });
  assert.equal(queue.push(evidence('hb-1', 'heartbeat', EVENT_TYPES.HEARTBEAT, 100)).coalesced, false);
  assert.equal(queue.push(evidence('hb-2', 'heartbeat', EVENT_TYPES.HEARTBEAT, 110)).coalesced, true);
  assert.equal(queue.size(), 1);
  assert.deepEqual(queue.drain().map((item) => item.evidenceId), ['hb-2']);
});

test('queue remains bounded and preserves terminal evidence under pressure', () => {
  const queue = createEvidenceQueue({ maxSize: 2 });
  queue.push(evidence('hb-1', 'heartbeat', EVENT_TYPES.HEARTBEAT, 100));
  queue.push(evidence('closed', 'native_hook', EVENT_TYPES.SESSION_CLOSED, 110));
  const result = queue.push(evidence('failed', 'native_hook', EVENT_TYPES.TURN_FAILED, 120));

  assert.equal(result.accepted, true);
  assert.equal(queue.size(), 2);
  assert.deepEqual(queue.drain().map((item) => item.evidenceId), ['closed', 'failed']);
  assert.equal(queue.size(), 0);
});

test('queue rejects a new non-coalescible item only when no removable high-frequency item exists', () => {
  const queue = createEvidenceQueue({ maxSize: 1 });
  queue.push(evidence('closed', 'native_hook', EVENT_TYPES.SESSION_CLOSED, 100));
  const result = queue.push(evidence('failed', 'native_hook', EVENT_TYPES.TURN_FAILED, 110));
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'queue_full');
  assert.deepEqual(queue.drain().map((item) => item.evidenceId), ['closed']);
});
