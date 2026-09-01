'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_MAX_BYTES = 128 * 1024;

function parseValue(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1).replace(/\\n/g, '\n').replace(/\\r/g, '\r');
  }
  return value.replace(/\s+#.*$/, '').trim();
}

function parseEnvContent(content) {
  const result = {};
  for (const rawLine of String(content || '').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const match = rawLine.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const value = parseValue(match[2]);
    if (value) result[match[1]] = value;
  }
  return result;
}

function loadEnvFile({ filePath, env = process.env, fsApi = fs, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const requested = String(filePath || '').trim();
  if (!requested || !env || typeof env !== 'object') return { loaded: false, path: '', keys: [] };
  const resolved = path.resolve(requested);
  let stat;
  try { stat = fsApi.statSync(resolved); } catch { return { loaded: false, path: resolved, keys: [] }; }
  if (!stat.isFile() || stat.size > maxBytes) return { loaded: false, path: resolved, keys: [] };
  let parsed;
  try { parsed = parseEnvContent(fsApi.readFileSync(resolved, 'utf8')); } catch { return { loaded: false, path: resolved, keys: [] }; }
  const loaded = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (env[key] !== undefined && String(env[key]).trim()) continue;
    env[key] = value;
    loaded.push(key);
  }
  return { loaded: true, path: resolved, keys: loaded };
}

function loadFirstEnvFile({ candidates = [], env = process.env, fsApi = fs, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  for (const candidate of candidates) {
    const result = loadEnvFile({ filePath: candidate, env, fsApi, maxBytes });
    if (result.loaded) return result;
  }
  return { loaded: false, path: '', keys: [] };
}

module.exports = { DEFAULT_MAX_BYTES, loadEnvFile, loadFirstEnvFile, parseEnvContent };
