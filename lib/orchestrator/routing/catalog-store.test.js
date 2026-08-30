'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createCatalogReader,
  loadCatalogCache,
  saveCatalogCache,
} = require('./catalog-store');

function makeCatalog(fetchedAt = 1_000, agentVersion = '0.151.0') {
  return {
    source: 'native', fetchedAt, agentVersion, etag: 'etag-1',
    models: [{
      id: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol', description: '',
      defaultReasoningLevel: 'medium', supportedReasoningLevels: ['low', 'medium', 'high'],
      visibility: 'list', supportedInApi: true, contextWindow: null, maxContextWindow: null,
    }],
  };
}

function tempCache(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-routing-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'models-cache.json');
}

test('prefers native catalog and atomically persists a normalized cache', async (t) => {
  const filePath = tempCache(t);
  let nativeCalls = 0;
  const reader = createCatalogReader({
    cachePath: filePath,
    now: () => 2_000,
    agentVersion: '0.151.0',
    nativeReader: async () => {
      nativeCalls += 1;
      return makeCatalog(null, '0.151.0');
    },
  });

  const result = await reader.read();

  assert.equal(nativeCalls, 1);
  assert.equal(result.source, 'native');
  assert.equal(result.available, true);
  assert.equal(result.stale, false);
  assert.equal(result.fetchedAt, 2_000);
  assert.equal(loadCatalogCache(filePath).models[0].id, 'gpt-5.6-sol');
});

test('falls back to a stale cache with an explicit stale marker', async (t) => {
  const filePath = tempCache(t);
  saveCatalogCache(makeCatalog(1_000), filePath);
  const reader = createCatalogReader({
    cachePath: filePath,
    now: () => 1_000 + 5 * 60 * 1000,
    agentVersion: '0.151.0',
    nativeReader: async () => { throw new Error('app server unavailable'); },
  });

  const result = await reader.read();

  assert.equal(result.source, 'cache');
  assert.equal(result.available, true);
  assert.equal(result.stale, true);
  assert.equal(result.reasonCode, 'NATIVE_CATALOG_UNAVAILABLE');
});

test('invalidates cache after an agent version change', async (t) => {
  const filePath = tempCache(t);
  saveCatalogCache(makeCatalog(1_000, '0.150.0'), filePath);
  const reader = createCatalogReader({
    cachePath: filePath,
    now: () => 1_001,
    agentVersion: '0.151.0',
    nativeReader: async () => { throw new Error('app server unavailable'); },
  });

  const result = await reader.read();

  assert.equal(result.source, 'unavailable');
  assert.equal(result.available, false);
  assert.equal(result.reasonCode, 'CATALOG_CACHE_INVALIDATED');
});

test('safely reports unavailable when the cache is corrupt', async (t) => {
  const filePath = tempCache(t);
  fs.writeFileSync(filePath, '{not-json', 'utf8');
  const reader = createCatalogReader({
    cachePath: filePath,
    nativeReader: async () => { throw new Error('app server unavailable'); },
  });

  const result = await reader.read();

  assert.equal(result.source, 'unavailable');
  assert.equal(result.available, false);
  assert.equal(result.reasonCode, 'CATALOG_UNAVAILABLE');
});
