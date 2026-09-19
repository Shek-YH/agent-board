'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { isAllowedExternalUrl } = require('./external-url');

test('external URL allowlist accepts only HTTP and HTTPS', () => {
  assert.equal(isAllowedExternalUrl('https://example.com'), true);
  assert.equal(isAllowedExternalUrl('http://example.com/path'), true);
  for (const value of ['file:///C:/Windows/system.ini', 'javascript:alert(1)', 'data:text/html,x', 'custom-protocol://x', 'not a URL']) {
    assert.equal(isAllowedExternalUrl(value), false, value);
  }
});
