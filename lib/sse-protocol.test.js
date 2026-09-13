'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { SseSequence, formatSseEvent, parseSseEnvelope } = require('./sse-protocol');

test('SSE sequence emits versioned, strictly increasing envelopes', () => {
  const sequence = new SseSequence(7);
  const first = sequence.next('active', { active: [] }, 100);
  const second = sequence.next('message', { count: 1 }, 101);

  assert.equal(first.version, 1);
  assert.equal(first.seq, 8);
  assert.equal(second.seq, 9);
  assert.equal(first.eventId, '8');
  assert.equal(second.eventId, '9');
  assert.equal(first.type, 'active');
  assert.deepEqual(second.payload, { count: 1 });
});

test('formatted SSE events round-trip through the envelope parser', () => {
  const text = formatSseEvent({
    version: 1,
    seq: 3,
    eventId: '3',
    type: 'active',
    at: 123,
    payload: { statuses: {} },
  });

  assert.match(text, /^id: 3\nevent: active\ndata: /);
  assert.deepEqual(parseSseEnvelope(text.match(/^data: (.+)$/m)[1]), {
    envelope: {
      version: 1,
      seq: 3,
      eventId: '3',
      type: 'active',
      at: 123,
      payload: { statuses: {} },
    },
    payload: { statuses: {} },
  });
});

test('parser keeps legacy payloads readable during rollout', () => {
  assert.deepEqual(parseSseEnvelope(JSON.stringify({ active: [] })), {
    envelope: null,
    payload: { active: [] },
  });
});
