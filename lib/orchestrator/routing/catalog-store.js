'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { getConfigDir } = require('../../runtime-paths');
const { normalizeCatalogResponse, isCatalogFresh } = require('./catalog');

const CACHE_SCHEMA_VERSION = 1;
const DEFAULT_CACHE_PATH = path.join(getConfigDir(), 'routing-models-cache.json');
const DEFAULT_CODEX_CACHE_PATH = path.join(os.homedir(), '.codex', 'models_cache.json');

function asAgentVersion(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function asNow(now) {
  const value = typeof now === 'function' ? now() : now;
  return Number.isFinite(Number(value)) ? Number(value) : Date.now();
}

function normalizeStoredCatalog(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.models)) return null;
  return normalizeCatalogResponse(value, {
    source: 'cache',
    fetchedAt: value.fetchedAt ?? value.fetched_at,
    agentVersion: value.agentVersion ?? value.agent_version,
    etag: value.etag,
  });
}

function cacheTimestamp(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function loadCodexCatalogCache(filePath = DEFAULT_CODEX_CACHE_PATH) {
  try {
    const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Array.isArray(payload.models)) return null;
    return normalizeCatalogResponse(payload, {
      source: 'codex-cache',
      fetchedAt: cacheTimestamp(payload.fetched_at ?? payload.fetchedAt),
      agentVersion: payload.client_version ?? payload.agentVersion,
      etag: payload.etag,
    });
  } catch {
    return null;
  }
}

function loadCatalogCache(filePath = DEFAULT_CACHE_PATH) {
  try {
    const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!payload || payload.schemaVersion !== CACHE_SCHEMA_VERSION) return null;
    return normalizeStoredCatalog(payload.catalog || payload);
  } catch {
    return null;
  }
}

function saveCatalogCache(catalog, filePath = DEFAULT_CACHE_PATH) {
  const normalized = normalizeStoredCatalog(catalog);
  if (!normalized) throw new TypeError('Invalid catalog cache');
  const payload = {
    schemaVersion: CACHE_SCHEMA_VERSION,
    fetchedAt: normalized.fetchedAt,
    agentVersion: normalized.agentVersion,
    etag: normalized.etag,
    models: normalized.models,
  };
  const directory = path.dirname(filePath);
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  fs.mkdirSync(directory, { recursive: true });
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify(payload), 'utf8');
    try {
      fs.renameSync(temporaryPath, filePath);
    } catch (error) {
      if (!['EEXIST', 'EPERM', 'ENOTEMPTY'].includes(error && error.code)) throw error;
      fs.unlinkSync(filePath);
      fs.renameSync(temporaryPath, filePath);
    }
  } finally {
    try { fs.unlinkSync(temporaryPath); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return normalized;
}

function unavailable(reasonCode, error = null) {
  return {
    source: 'unavailable',
    models: [],
    available: false,
    stale: false,
    reasonCode,
    error: error instanceof Error ? error.message : (error ? String(error) : null),
  };
}

function createCatalogReader({
  nativeReader,
  cachePath = DEFAULT_CACHE_PATH,
  codexCachePath = null,
  fallbackReaders = [],
  ttlMs = 5 * 60 * 1000,
  now = Date.now,
  agentVersion = null,
} = {}) {
  const currentVersion = asAgentVersion(agentVersion);
  const readNative = typeof nativeReader === 'function'
    ? nativeReader
    : nativeReader && typeof nativeReader.listModels === 'function'
      ? () => nativeReader.listModels()
      : null;
  const externalReaders = [
    ...(typeof fallbackReaders === 'function' ? [fallbackReaders] : Array.isArray(fallbackReaders) ? fallbackReaders : []),
    ...(codexCachePath ? [() => loadCodexCatalogCache(codexCachePath)] : []),
  ].filter((reader) => typeof reader === 'function');

  return {
    async read() {
      let nativeError = null;
      if (readNative) {
        try {
          const native = normalizeCatalogResponse(await readNative(), {
            source: 'native',
            fetchedAt: asNow(now),
            agentVersion: currentVersion,
          });
          try { saveCatalogCache(native, cachePath); } catch { /* cache persistence is best effort */ }
          return { ...native, available: true, stale: false, reasonCode: 'NATIVE_CATALOG' };
        } catch (error) {
          nativeError = error;
        }
      }

      const cached = loadCatalogCache(cachePath);
      const candidates = [
        cached ? { catalog: cached, source: 'cache' } : null,
      ].filter(Boolean);
      for (const readExternal of externalReaders) {
        try {
          const external = await readExternal();
          if (!external || typeof external !== 'object' || !Array.isArray(external.models)) continue;
          const catalog = normalizeCatalogResponse(external, {
            source: external.source || 'adapter-cache',
            fetchedAt: external.fetchedAt ?? external.fetched_at,
            agentVersion: external.agentVersion ?? external.agent_version,
            etag: external.etag,
          });
          candidates.push({ catalog, source: catalog.source || 'adapter-cache' });
        } catch { /* Adapter-owned cache is best effort. */ }
      }
      const compatible = candidates.find(({ catalog }) => !currentVersion || catalog.agentVersion === currentVersion);
      if (compatible) {
        const { catalog, source } = compatible;
        return {
          ...catalog,
          source,
          available: true,
          stale: !isCatalogFresh(catalog, asNow(now), ttlMs, currentVersion),
          reasonCode: nativeError ? 'NATIVE_CATALOG_UNAVAILABLE' : source === 'codex-cache' ? 'CODEX_CACHE' : 'CACHE_CATALOG',
        };
      }
      return unavailable(candidates.length ? 'CATALOG_CACHE_INVALIDATED' : 'CATALOG_UNAVAILABLE', nativeError);
    },
    async refresh() {
      return this.read();
    },
  };
}

module.exports = {
  CACHE_SCHEMA_VERSION,
  DEFAULT_CACHE_PATH,
  DEFAULT_CODEX_CACHE_PATH,
  createCatalogReader,
  loadCatalogCache,
  loadCodexCatalogCache,
  saveCatalogCache,
};
