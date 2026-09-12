'use strict';

function assertStorage(adapter) {
  if (!adapter || typeof adapter.load !== 'function' || typeof adapter.save !== 'function') {
    throw new TypeError('storage adapter requires load() and save()');
  }
  return adapter;
}

module.exports = { assertStorage };
