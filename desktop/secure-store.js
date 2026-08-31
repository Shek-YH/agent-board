'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const STORE_VERSION = 1;
const SUPPORTED_PROVIDERS = Object.freeze([
  'dashscope', 'zai', 'ark', 'minimax', 'deepgram', 'elevenlabs',
  'openai', 'anthropic', 'gemini', 'deepseek', 'openrouter', 'openai-compatible',
]);

function normalizeProvider(value) {
  const provider = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return SUPPORTED_PROVIDERS.includes(provider) ? provider : '';
}

function providerEnvName(provider) {
  const normalized = normalizeProvider(provider);
  return normalized ? `${normalized.toUpperCase().replace(/-/g, '_')}_API_KEY` : '';
}

function secureStorageError(code, reason) {
  const error = new Error(reason);
  error.code = code;
  return error;
}

class SecureStore {
  constructor({ safeStorage, filePath } = {}) {
    this.safeStorage = safeStorage;
    this.filePath = filePath;
    if (!filePath || typeof filePath !== 'string') throw new TypeError('secure store file path is required');
  }

  isAvailable() {
    try {
      return Boolean(this.safeStorage && typeof this.safeStorage.encryptString === 'function'
        && typeof this.safeStorage.decryptString === 'function'
        && (typeof this.safeStorage.isEncryptionAvailable !== 'function' || this.safeStorage.isEncryptionAvailable()));
    } catch {
      return false;
    }
  }

  assertAvailable() {
    if (!this.isAvailable()) throw secureStorageError('SECURE_STORAGE_UNAVAILABLE', 'Electron secure storage is unavailable');
  }

  readPayload() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (!raw || raw.version !== STORE_VERSION || !raw.providers || typeof raw.providers !== 'object' || Array.isArray(raw.providers)) {
        throw secureStorageError('SECURE_STORE_CORRUPT', 'secure store format is invalid');
      }
      return raw;
    } catch (error) {
      if (error && error.code === 'ENOENT') return { version: STORE_VERSION, providers: {}, activeProvider: null };
      if (error && error.code === 'SECURE_STORE_CORRUPT') throw error;
      throw secureStorageError('SECURE_STORE_CORRUPT', 'secure store cannot be read');
    }
  }

  encrypt(value) {
    try {
      return this.safeStorage.encryptString(value).toString('base64');
    } catch {
      throw secureStorageError('SECURE_STORAGE_ENCRYPT_FAILED', 'secure storage encryption failed');
    }
  }

  decrypt(value) {
    if (typeof value !== 'string' || !value) return '';
    try {
      return this.safeStorage.decryptString(Buffer.from(value, 'base64'));
    } catch {
      throw secureStorageError('SECURE_STORAGE_DECRYPT_FAILED', 'secure storage decryption failed');
    }
  }

  writePayload(payload) {
    const directory = path.dirname(this.filePath);
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    fs.mkdirSync(directory, { recursive: true });
    try {
      fs.writeFileSync(temporaryPath, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(temporaryPath, this.filePath);
    } finally {
      try { fs.unlinkSync(temporaryPath); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }

  getProviderApiKey(provider) {
    this.assertAvailable();
    const normalized = normalizeProvider(provider);
    if (!normalized) return '';
    const payload = this.readPayload();
    return this.decrypt(payload.providers[normalized]);
  }

  setProviderApiKey(provider, apiKey) {
    this.assertAvailable();
    const normalized = normalizeProvider(provider);
    if (!normalized) throw secureStorageError('PROVIDER_UNSUPPORTED', 'provider is not supported');
    if (typeof apiKey !== 'string' || !apiKey.trim()) throw secureStorageError('API_KEY_REQUIRED', 'api key is required');
    if (apiKey.length > 4_096 || /[\u0000\r\n]/.test(apiKey)) throw secureStorageError('API_KEY_INVALID', 'api key is invalid');
    const payload = this.readPayload();
    payload.providers[normalized] = this.encrypt(apiKey);
    payload.activeProvider = this.encrypt(normalized);
    this.writePayload(payload);
    return this.status();
  }

  clearProviderApiKey(provider) {
    this.assertAvailable();
    const normalized = normalizeProvider(provider);
    if (!normalized) throw secureStorageError('PROVIDER_UNSUPPORTED', 'provider is not supported');
    const payload = this.readPayload();
    delete payload.providers[normalized];
    if (this.decrypt(payload.activeProvider) === normalized) payload.activeProvider = null;
    this.writePayload(payload);
    return this.status();
  }

  getActiveProvider() {
    this.assertAvailable();
    const payload = this.readPayload();
    const active = normalizeProvider(this.decrypt(payload.activeProvider));
    return active && payload.providers[active] ? active : null;
  }

  status() {
    if (!this.isAvailable()) return { available: false, configuredProviders: [], activeProvider: null };
    try {
      const payload = this.readPayload();
      const configuredProviders = SUPPORTED_PROVIDERS.filter((provider) => Boolean(payload.providers[provider]));
      const active = normalizeProvider(this.decrypt(payload.activeProvider));
      return {
        available: true,
        configuredProviders,
        activeProvider: active && configuredProviders.includes(active) ? active : null,
      };
    } catch (error) {
      return { available: false, configuredProviders: [], activeProvider: null, code: error.code || 'SECURE_STORE_UNAVAILABLE' };
    }
  }
}

function createSecureStore(options) {
  return new SecureStore(options);
}

module.exports = {
  STORE_VERSION,
  SUPPORTED_PROVIDERS,
  SecureStore,
  createSecureStore,
  normalizeProvider,
  providerEnvName,
};
