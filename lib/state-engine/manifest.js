'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MANIFEST_DIR = path.join(__dirname, '..', 'agent-manifests');
const ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const REQUIRED_CAPABILITIES = ['hooks', 'jsonl', 'process', 'heartbeat', 'appServer', 'pty', 'uiFallback'];
const REQUIRED_AUTHORITY = ['turn', 'activity', 'liveness', 'sessionLifecycle'];

function deepFreeze(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const item of Object.values(value)) deepFreeze(item, seen);
  return Object.freeze(value);
}

function validateManifest(input, expectedAgent) {
  if (!input || typeof input !== 'object' || input.agent !== expectedAgent || input.version !== 1) throw new Error(`invalid agent manifest: ${expectedAgent}`);
  if (!input.capabilities || REQUIRED_CAPABILITIES.some((key) => typeof input.capabilities[key] !== 'boolean')) throw new Error(`invalid agent manifest capabilities: ${expectedAgent}`);
  if (!input.authority || REQUIRED_AUTHORITY.some((key) => !Array.isArray(input.authority[key]) || input.authority[key].some((source) => typeof source !== 'string'))) throw new Error(`invalid agent manifest authority: ${expectedAgent}`);
  if (!input.timeouts || Object.values(input.timeouts).some((value) => !Number.isFinite(Number(value)) || Number(value) < 0)) throw new Error(`invalid agent manifest timeouts: ${expectedAgent}`);
  return deepFreeze(input);
}

function loadAgentManifest(agent) {
  const id = String(agent || '').trim().toLowerCase();
  if (!ID_PATTERN.test(id)) throw new Error(`invalid agent manifest id: ${id || 'empty'}`);
  const filePath = path.join(MANIFEST_DIR, `${id}.json`);
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return validateManifest(parsed, id);
  } catch (error) {
    if (error && error.code === 'ENOENT') throw new Error(`agent manifest not found: ${id}`);
    if (error && /^invalid agent manifest/.test(error.message || '')) throw error;
    throw new Error(`agent manifest unreadable: ${id}`);
  }
}

function loadAllAgentManifests() {
  let names;
  try { names = fs.readdirSync(MANIFEST_DIR).filter((name) => name.endsWith('.json')).sort(); } catch { return {}; }
  const result = {};
  for (const name of names) {
    const id = name.slice(0, -5);
    result[id] = loadAgentManifest(id);
  }
  return Object.freeze(result);
}

module.exports = { MANIFEST_DIR, loadAgentManifest, loadAllAgentManifests };
