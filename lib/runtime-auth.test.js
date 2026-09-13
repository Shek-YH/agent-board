'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createRuntimeAuth, authorizeUiRequest, authorizeUiMutation } = require('./runtime-auth');

function request(overrides = {}) {
  return {
    method: 'POST',
    headers: {
      host: '127.0.0.1:4876',
      origin: 'http://127.0.0.1:4876',
      authorization: 'Bearer ' + 'a'.repeat(64),
      'content-type': 'application/json',
      'content-length': '20',
    },
    socket: { remoteAddress: '127.0.0.1' },
    ...overrides,
  };
}

test('UI runtime auth generates high-entropy token and accepts the exact local request', () => {
  const auth = createRuntimeAuth({ randomBytes: (size) => Buffer.alloc(size, 7) });
  assert.equal(auth.token, '07'.repeat(32));
  assert.equal(authorizeUiRequest(request({}), { port: 4876 }), true);
  assert.equal(authorizeUiMutation(request({ headers: { ...request().headers, authorization: `Bearer ${auth.token}` } }), auth.token, { port: 4876 }), true);
});

test('UI runtime auth rejects wrong token, remote host, origin, and non-JSON mutation', () => {
  const token = 'a'.repeat(64);
  assert.equal(authorizeUiMutation(request({}), token, { port: 4876 }), true);
  assert.equal(authorizeUiMutation(request({ headers: { ...request().headers, authorization: 'Bearer wrong' } }), token, { port: 4876 }), false);
  assert.equal(authorizeUiMutation(request({ socket: { remoteAddress: '192.168.1.10' } }), token, { port: 4876 }), false);
  assert.equal(authorizeUiMutation(request({ headers: { ...request().headers, origin: 'http://evil.test' } }), token, { port: 4876 }), false);
  assert.equal(authorizeUiMutation(request({ headers: { ...request().headers, 'content-type': 'text/plain' } }), token, { port: 4876 }), false);
  assert.equal(authorizeUiMutation(request({ headers: { ...request().headers, 'content-length': String(11 * 1024 * 1024) } }), token, { port: 4876 }), false);
});

test('UI runtime auth allows empty-body mutations without inventing a content type', () => {
  const token = 'a'.repeat(64);
  const headers = { ...request().headers, authorization: `Bearer ${token}`, 'content-length': '0' };
  delete headers['content-type'];
  assert.equal(authorizeUiMutation(request({ headers }), token, { port: 4876 }), true);
});
