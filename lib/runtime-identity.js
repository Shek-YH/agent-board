'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function resolveOptionalPath(value) {
  return typeof value === 'string' && value.trim() ? path.resolve(value) : null;
}

function sha256File(filePath) {
  if (!filePath) return null;
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  } catch {
    return null;
  }
}

function buildRuntimeIdentity({
  serverRoot,
  serverEntry,
  cwd = process.cwd(),
  nodeRuntime = process.execPath,
  nodeVersion = process.version,
  pid = process.pid,
  ppid = process.ppid,
  port,
  startedAt = new Date().toISOString(),
  runtimeMode = 'source',
  dataDir,
  configDir,
} = {}) {
  const resolvedEntry = resolveOptionalPath(serverEntry);
  const resolvedRoot = resolveOptionalPath(serverRoot)
    || (resolvedEntry ? path.dirname(resolvedEntry) : null);
  return {
    schemaVersion: 1,
    pid: Number.isInteger(pid) ? pid : null,
    ppid: Number.isInteger(ppid) ? ppid : null,
    startedAt,
    runtimeMode,
    serverRoot: resolvedRoot,
    serverEntry: resolvedEntry,
    cwd: resolveOptionalPath(cwd),
    nodeRuntime: resolveOptionalPath(nodeRuntime),
    nodeVersion: typeof nodeVersion === 'string' && nodeVersion.trim() ? nodeVersion : null,
    port: Number.isFinite(Number(port)) ? Number(port) : null,
    dataDir: resolveOptionalPath(dataDir),
    configDir: resolveOptionalPath(configDir),
    // This is deliberately calculated while the process starts. Reading the
    // file later would let an old process report the new source after an
    // in-place copy, which is exactly the stale-server failure this metadata
    // is meant to expose.
    serverEntrySha256: sha256File(resolvedEntry),
  };
}

module.exports = { buildRuntimeIdentity };
