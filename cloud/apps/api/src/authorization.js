'use strict';

const ADMIN_ROLES = new Set(['SUPER_ADMIN', 'ADMIN']);

function isAdminRole(role) {
  return typeof role === 'string' && ADMIN_ROLES.has(role);
}

function canAccessAdmin(profile) {
  return Boolean(profile) && profile.status === 'ACTIVE' && isAdminRole(profile.role);
}

module.exports = { ADMIN_ROLES, canAccessAdmin, isAdminRole };
