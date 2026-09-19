'use strict';

function isAllowedExternalUrl(value) {
  try {
    return ['https:', 'http:'].includes(new URL(String(value)).protocol);
  } catch {
    return false;
  }
}

module.exports = { isAllowedExternalUrl };
