'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { EVENT_TYPES, EVIDENCE_SOURCES } = require('../state-engine/enums');
const { createCodexStateAdapter, legacyEventToEvidence } = require('./codex-state-adapter');

function legacyEvent(overrides = {}) {
  return {
    agent: 'codex',
    sessionId: 'session-1',
    sourceId: 'source-1',
    ts: 100,
    kind: 'turn_start',
    turnId: 'turn-1',
    text: 'do not persist this message',
    ...overrides,
  };
}

test('Codex turn and message events become metadata-only Evidence', () => {
  const started = legacyEventToEvidence(legacyEvent());
  const user = legacyEventToEvidence(legacyEvent({ kind: 'message', role: 'user', sourceId: 'source-2', ts: 110 }));
  const completed = legacyEventToEvidence(legacyEvent({ kind: 'turn_end', turnStatus: 'completed', sourceId: 'source-3', ts: 120 }));

  assert.equal(started.signalType, EVENT_TYPES.TURN_STARTED);
  assert.equal(started.source, EVIDENCE_SOURCES.JSONL);
  assert.deepEqual(started.value, { turnId: 'turn-1' });
  assert.equal(user.signalType, EVENT_TYPES.USER_MESSAGE);
  assert.deepEqual(user.value, { turnId: 'turn-1' });
  assert.equal(completed.signalType, EVENT_TYPES.TURN_COMPLETION_SIGNAL);
  assert.equal(completed.value.turnId, 'turn-1');
  assert.equal(completed.evidence, undefined);
  assert.equal(Object.hasOwn(user, 'text'), false);
});

test('Codex failed and interrupted turn events keep distinct signals', () => {
  assert.equal(
    legacyEventToEvidence(legacyEvent({ kind: 'turn_end', turnStatus: 'failed' })).signalType,
    EVENT_TYPES.TURN_FAILED,
  );
  assert.equal(
    legacyEventToEvidence(legacyEvent({ kind: 'turn_end', turnStatus: 'interrupted' })).signalType,
    EVENT_TYPES.TURN_INTERRUPTED,
  );
});

test('Codex adapter emits deterministic evidence and supports shadow-only collection', () => {
  const emitted = [];
  const adapter = createCodexStateAdapter({ mode: 'shadow', emit: (item) => emitted.push(item) });
  const result = adapter.collect([
    legacyEvent({ sourceId: 'a', ts: 100 }),
    legacyEvent({ kind: 'turn_end', sourceId: 'b', ts: 200 }),
  ], { observedAt: 250 });

  assert.equal(result.length, 2);
  assert.deepEqual(emitted, result);
  assert.equal(result[0].occurredAt, 100);
  assert.equal(result[0].observedAt, 250);
  assert.equal(result[1].evidenceId, 'b');
});

test('Codex adapter stays disabled when the V2 feature flag is off', () => {
  const emitted = [];
  const adapter = createCodexStateAdapter({ mode: 'off', emit: (item) => emitted.push(item) });
  assert.deepEqual(adapter.collect([legacyEvent()]), []);
  assert.deepEqual(emitted, []);
});

test('Codex child topology is structural metadata and never changes the parent adapter state', () => {
  const child = legacyEventToEvidence(legacyEvent({
    sessionRole: 'child', parentSessionId: 'parent-1', rootSessionId: 'root-1', sourceId: 'child-1',
  }));
  assert.deepEqual(child.value, { turnId: 'turn-1', sessionRole: 'child', parentSessionRef: 'codex:parent-1', rootSessionRef: 'codex:root-1' });
});
