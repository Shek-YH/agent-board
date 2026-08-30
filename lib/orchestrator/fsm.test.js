'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { AUTO_STATES, assertAutoTransition, autoStateForStatus, statusForAutoState } = require('./fsm');

test('maps the persistent auto states to the compatible workflow statuses', () => {
  assert.deepEqual(AUTO_STATES, [
    'OFF', 'PREFLIGHT', 'WAITING_AGENT', 'REVIEWING', 'DISPATCHING',
    'VERIFYING', 'PAUSED', 'BLOCKED', 'DONE', 'STOPPED',
  ]);
  assert.equal(autoStateForStatus('running'), 'WAITING_AGENT');
  assert.equal(statusForAutoState('VERIFYING'), 'verifying');
  assert.equal(statusForAutoState('STOPPED'), 'paused');
});

test('allows only explicit safe auto state transitions', () => {
  assert.doesNotThrow(() => assertAutoTransition('OFF', 'PREFLIGHT'));
  assert.doesNotThrow(() => assertAutoTransition('VERIFYING', 'WAITING_AGENT'));
  assert.doesNotThrow(() => assertAutoTransition('DISPATCHING', 'VERIFYING'));
  assert.doesNotThrow(() => assertAutoTransition('PAUSED', 'DONE'));
  assert.throws(() => assertAutoTransition('OFF', 'DISPATCHING'), /illegal auto transition/);
  assert.throws(() => assertAutoTransition('DONE', 'PREFLIGHT'), /illegal auto transition/);
});
