'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { GuiBus } = require('./gui-bus');

test('GuiBus serializes the same Agent and Session while allowing different sessions', async () => {
  const bus = new GuiBus();
  const order = [];
  let release;
  const first = bus.run({ agent: 'codex', sessionRef: 's1' }, async () => {
    order.push('first-start');
    await new Promise((resolve) => { release = resolve; });
    order.push('first-end');
  });
  const second = bus.run({ agent: 'codex', sessionRef: 's1' }, async () => { order.push('second'); });
  const other = bus.run({ agent: 'codex', sessionRef: 's2' }, async () => { order.push('other'); });
  await other;
  assert.deepEqual(order, ['first-start', 'other']);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first-start', 'other', 'first-end', 'second']);
});

