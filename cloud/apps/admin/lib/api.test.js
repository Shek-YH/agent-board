const test = require('node:test');
const assert = require('node:assert/strict');

const { apiUrl } = require('./api');

test('apiUrl joins the configured API origin without duplicating slashes', () => {
  assert.equal(
    apiUrl('/v1/admin/users', 'http://127.0.0.1:3200/'),
    'http://127.0.0.1:3200/v1/admin/users',
  );
});

test('apiUrl rejects non-origin API configuration', () => {
  assert.throws(() => apiUrl('/v1/admin/users', 'javascript:alert(1)'), /valid API origin/i);
});
