'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createHookAuth, authorizeHookRequest } = require('./workbuddy-http');

function request({ address = '127.0.0.1', authorization, contentType = 'application/json' } = {}) {
  return {
    headers: { ...(authorization ? { authorization } : {}), 'content-type': contentType },
    socket: { remoteAddress: address },
  };
}

test('complete hook uses an independent 256-bit token and fails closed for untrusted requests', () => {
  const complete = createHookAuth({
    env: { AGENT_BOARD_COMPLETE_HOOK_TOKEN: 'c'.repeat(64) },
    envKey: 'AGENT_BOARD_COMPLETE_HOOK_TOKEN',
  });
  const workbuddy = createHookAuth({ env: { AGENT_BOARD_WORKBUDDY_HTTP_TOKEN: 'w'.repeat(64) } });

  assert.equal(complete.token, 'c'.repeat(64));
  assert.notEqual(complete.token, workbuddy.token);
  assert.equal(authorizeHookRequest(request({ authorization: `Bearer ${complete.token}` }), complete.token), true);
  assert.equal(authorizeHookRequest(request(), complete.token), false);
  assert.equal(authorizeHookRequest(request({ authorization: 'Bearer wrong' }), complete.token), false);
  assert.equal(authorizeHookRequest(request({ address: '10.0.0.5', authorization: `Bearer ${complete.token}` }), complete.token), false);
  assert.equal(authorizeHookRequest(request({ authorization: `Bearer ${complete.token}`, contentType: 'text/plain' }), complete.token), false);
});
