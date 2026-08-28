'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { RateLimitService, createRateLimitService } = require('./rate-limit.service');

test('rate limiting combines IP, user, and device dimensions and resets after the window', () => {
  let now = 0;
  const service = new RateLimitService({ limits: { redeem: { max: 2, windowSeconds: 10 } }, clock: () => now });
  const input = { route: 'redeem', ip: '10.0.0.1', userId: 'user-1', deviceId: 'device-1' };

  service.consume(input);
  service.consume(input);
  assert.throws(() => service.consume(input), (error) => error.getResponse().code === 'RATE_LIMITED');
  now = 10001;
  assert.equal(service.consume(input).limited, false);
});

test('changing one dimension cannot bypass the shared IP bucket and limited events are reported', () => {
  const events = [];
  const service = createRateLimitService({ limits: { login: { max: 1, windowSeconds: 60 } }, clock: () => 0, onLimited: (event) => events.push(event) });
  service.consume({ route: 'login', ip: '10.0.0.1' });
  assert.throws(() => service.consume({ route: 'login', ip: '10.0.0.1', userId: 'different-user' }), (error) => error.getResponse().code === 'RATE_LIMITED');
  assert.equal(events[0].type, 'RATE_LIMITED');
  assert.equal(events[0].metadata.route, 'login');
});
