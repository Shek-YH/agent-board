'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { OrchestrationEvents } = require('./events');

test('session messages emit normalized orchestration events once', () => {
  const events = new OrchestrationEvents();
  const received = [];
  events.on('session_message', (event) => received.push(event));
  const message = {
    agent: 'codex', sourceId: 'msg-1', sessionId: 'sid-1', sessionRef: 'codex:sid-1',
    project: 'C:\\work\\app', ts: 1234, role: 'assistant', text: '完成了一步',
  };
  events.emitSessionMessage(message);
  events.emitSessionMessage(message);
  assert.equal(received.length, 1);
  assert.deepEqual(received[0], { ...message, origin: 'agent-board' });
});

test('event bridge does not alter arbitrary event payloads', () => {
  const events = new OrchestrationEvents();
  const payload = { id: 'x', value: 1 };
  let received;
  events.on('custom', (event) => { received = event; });
  events.emit('custom', payload);
  assert.strictEqual(received, payload);
});
