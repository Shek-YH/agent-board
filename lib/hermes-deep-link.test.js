'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { buildHermesDesktopDeepLink } = require('./hermes-deep-link');

test('构造 Hermes Desktop stored session 深链', () => {
  assert.equal(
    buildHermesDesktopDeepLink('20260824_071530_a1b2c3d4'),
    'hermes://session/20260824_071530_a1b2c3d4',
  );
});

test('拒绝会注入路径或协议的 Hermes session id', () => {
  assert.throws(() => buildHermesDesktopDeepLink('../settings'), /sessionId/);
  assert.throws(() => buildHermesDesktopDeepLink('has space'), /sessionId/);
});
