'use strict';

const fs = require('node:fs');
const path = require('node:path');

function storageError(message) {
  const error = new Error(message);
  error.code = 'SECURE_STORAGE_UNAVAILABLE';
  return error;
}

function createSecureStore({ safeStorage, filePath } = {}) {
  if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== 'function') {
    throw storageError('Electron secure storage is unavailable');
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw storageError('Electron secure storage encryption is unavailable');
  }
  if (typeof safeStorage.encryptString !== 'function' || typeof safeStorage.decryptString !== 'function') {
    throw storageError('Electron secure storage API is incomplete');
  }
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw new TypeError('Secure storage file path is required');
  }

  return {
    read() {
      try {
        const encrypted = fs.readFileSync(filePath);
        const value = safeStorage.decryptString(encrypted);
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
      } catch {
        return null;
      }
    },

    write(value) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError('Secure storage value must be an object');
      }
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const encrypted = safeStorage.encryptString(JSON.stringify(value));
      fs.writeFileSync(filePath, encrypted);
    },

    clear() {
      try {
        fs.unlinkSync(filePath);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    },
  };
}

module.exports = { createSecureStore };
