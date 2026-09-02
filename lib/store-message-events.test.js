'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const store = require('../test-support/store-fixture');
const { fingerprint } = require('./orchestrator/hosted-agent');

test('store emits a redacted assistant-ingest event only for a new message', () => {
  const events = [];
  const stop = store.onMessageIngested((event) => events.push(event));
  const now = Date.now();
  store.ingest({
    agent: 'codex', sourceId: 'event-bridge-assistant', sessionId: 'event-bridge-session',
    ts: now, role: 'assistant', kind: 'message', text: 'PROMPT=secret TOKEN=secret', project: 'C:\\Projects\\event-bridge',
  });
  store.ingest({
    agent: 'codex', sourceId: 'event-bridge-assistant', sessionId: 'event-bridge-session',
    ts: now, role: 'assistant', kind: 'message', text: 'same source replay', project: 'C:\\Projects\\event-bridge',
  });
  store.ingest({
    agent: 'codex', sourceId: 'event-bridge-user', sessionId: 'event-bridge-session',
    ts: now + 1, role: 'user', kind: 'message', text: '用户消息', project: 'C:\\Projects\\event-bridge',
  });
  stop();

  assert.equal(events.length, 1);
  assert.equal(events[0].agent, 'codex');
  assert.equal(events[0].sessionRef, 'codex:event-bridge-session');
  assert.equal(events[0].messageId, fingerprint('event-bridge-assistant'));
  assert.doesNotMatch(JSON.stringify(events[0]), /PROMPT=secret|TOKEN=secret/);
});
