'use strict';

const FORBIDDEN_ADAPTER_KEYS = new Set([
  'writeUiState', 'setSessionStatus', 'broadcastCompletion', 'notifyCompletion',
]);
const OPTIONAL_METHODS = ['discoverSessions', 'resolveIdentity', 'inspectProcess', 'watchTranscript', 'getJumpTarget'];

function validateAgentMonitorAdapter(adapter, manifest) {
  if (!adapter || typeof adapter !== 'object') throw new TypeError('agent adapter is required');
  if (!manifest || typeof manifest !== 'object') throw new TypeError('agent manifest is required');
  if (String(adapter.agentId || '') !== String(manifest.agent || '')) throw new TypeError('adapter agentId does not match manifest');
  if (typeof adapter.collectEvidence !== 'function') throw new TypeError('adapter collectEvidence is required');
  for (const key of FORBIDDEN_ADAPTER_KEYS) {
    if (typeof adapter[key] === 'function') throw new TypeError(`direct state/UI/notification writes are forbidden: ${key}`);
  }
  for (const method of OPTIONAL_METHODS) {
    if (adapter[method] !== undefined && typeof adapter[method] !== 'function') throw new TypeError(`adapter ${method} must be a function`);
  }
  return createAgentMonitorAdapter({ ...adapter, manifest });
}

/** @param {{agentId?: string, manifest?: Object, collectEvidence?: Function, [key: string]: *}} input */
function createAgentMonitorAdapter(input = {}) {
  const { agentId, manifest, collectEvidence, ...methods } = input;
  if (!manifest || manifest.agent !== agentId) throw new TypeError('adapter agentId does not match manifest');
  if (typeof collectEvidence !== 'function') throw new TypeError('adapter collectEvidence is required');
  for (const key of FORBIDDEN_ADAPTER_KEYS) {
    if (typeof methods[key] === 'function') throw new TypeError(`direct state/UI/notification writes are forbidden: ${key}`);
  }
  const result = { agentId, capabilities: manifest.capabilities, collectEvidence };
  for (const method of OPTIONAL_METHODS) {
    if (typeof methods[method] === 'function') result[method] = methods[method];
  }
  return Object.freeze(result);
}

module.exports = { createAgentMonitorAdapter, validateAgentMonitorAdapter };
