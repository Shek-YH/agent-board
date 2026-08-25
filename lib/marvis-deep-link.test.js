'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { buildMarvisDeepLink } = require('./marvis-deep-link');

test('构造 Marvis conversation share 会话深链', () => {
  assert.equal(
    buildMarvisDeepLink('conv_1a032a7b0cd_ee89d2ec51a1'),
    'marvis://conversation/share?id=conv_1a032a7b0cd_ee89d2ec51a1',
  );
});

test('拒绝会注入路径或协议的 Marvis session id', () => {
  assert.throws(() => buildMarvisDeepLink('../settings'), /sessionId/);
  assert.throws(() => buildMarvisDeepLink('has space'), /sessionId/);
  assert.throws(() => buildMarvisDeepLink('marvis://chat/other'), /sessionId/);
});
