'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createSecureStore, providerEnvName, SUPPORTED_PROVIDERS } = require('./secure-store');

function makeStore() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-secure-store-'));
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`encrypted:${value}`, 'utf8'),
    decryptString: (value) => String(value).replace(/^encrypted:/, ''),
  };
  return {
    directory,
    store: createSecureStore({ safeStorage, filePath: path.join(directory, 'provider-keys.json') }),
  };
}

test('secure provider store encrypts credentials and exposes only safe status', () => {
  const { directory, store } = makeStore();
  const result = store.setProviderApiKey('openai', 'sk-test-secret');
  const raw = fs.readFileSync(path.join(directory, 'provider-keys.json'), 'utf8');

  assert.deepEqual(result, { available: true, configuredProviders: ['openai'], activeProvider: 'openai' });
  assert.equal(store.getProviderApiKey('openai'), 'sk-test-secret');
  assert.equal(store.getActiveProvider(), 'openai');
  assert.doesNotMatch(raw, /sk-test-secret/);
  assert.doesNotMatch(JSON.stringify(store.status()), /sk-test-secret/);
  assert.equal(providerEnvName('openai-compatible'), 'OPENAI_COMPATIBLE_API_KEY');
});

test('secure provider store accepts shared domestic and voice providers', () => {
  const { store } = makeStore();
  for (const provider of ['dashscope', 'zai', 'ark', 'minimax', 'deepgram', 'elevenlabs']) {
    store.setProviderApiKey(provider, `${provider}-secret`);
  }

  assert.ok(SUPPORTED_PROVIDERS.includes('dashscope'));
  assert.ok(SUPPORTED_PROVIDERS.includes('zai'));
  assert.ok(SUPPORTED_PROVIDERS.includes('ark'));
  assert.ok(SUPPORTED_PROVIDERS.includes('minimax'));
  assert.ok(SUPPORTED_PROVIDERS.includes('deepgram'));
  assert.ok(SUPPORTED_PROVIDERS.includes('elevenlabs'));
  assert.deepEqual(store.status().configuredProviders, ['dashscope', 'zai', 'ark', 'minimax', 'deepgram', 'elevenlabs']);
});

test('secure provider store clears credentials without leaving a plaintext secret', () => {
  const { directory, store } = makeStore();
  store.setProviderApiKey('deepseek', 'deep-secret');
  const result = store.clearProviderApiKey('deepseek');

  assert.deepEqual(result, { available: true, configuredProviders: [], activeProvider: null });
  assert.equal(store.getProviderApiKey('deepseek'), '');
  assert.doesNotMatch(fs.readFileSync(path.join(directory, 'provider-keys.json'), 'utf8'), /deep-secret/);
});

test('secure provider store fails closed when Electron encryption is unavailable', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-secure-store-'));
  const store = createSecureStore({
    safeStorage: { isEncryptionAvailable: () => false },
    filePath: path.join(directory, 'provider-keys.json'),
  });

  assert.deepEqual(store.status(), { available: false, configuredProviders: [], activeProvider: null });
  assert.throws(() => store.setProviderApiKey('openai', 'secret'), (error) => error.code === 'SECURE_STORAGE_UNAVAILABLE');
});
