const test = require('node:test');
const assert = require('node:assert/strict');

const { canAccessAdmin, isAdminRole } = require('./authorization');

test('only active SUPER_ADMIN and ADMIN profiles can access admin APIs', () => {
  assert.equal(canAccessAdmin({ role: 'SUPER_ADMIN', status: 'ACTIVE' }), true);
  assert.equal(canAccessAdmin({ role: 'ADMIN', status: 'ACTIVE' }), true);
  assert.equal(canAccessAdmin({ role: 'ADMIN', status: 'DISABLED' }), false);
  assert.equal(canAccessAdmin({ role: 'AGENT', status: 'ACTIVE' }), false);
  assert.equal(canAccessAdmin(null), false);
});

test('role matching is explicit and does not accept lookalike values', () => {
  assert.equal(isAdminRole('ADMIN'), true);
  assert.equal(isAdminRole('SUPER_ADMIN'), true);
  assert.equal(isAdminRole('admin'), false);
  assert.equal(isAdminRole('ADMIN,USER'), false);
  assert.equal(isAdminRole(['ADMIN']), false);
});
