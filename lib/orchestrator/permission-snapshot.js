'use strict';

const crypto = require('node:crypto');
const path = require('node:path');

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function text(value, fallback = '', max = 2_000) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : fallback;
}

function bool(value, fallback = false) {
  return typeof value === 'boolean' ? value : fallback;
}

function list(value, fallback = [], maxItems = 100, maxLength = 200) {
  if (!Array.isArray(value)) return [...fallback];
  return [...new Set(value.map((item) => typeof item === 'string' ? item.trim().slice(0, maxLength) : '').filter(Boolean))].slice(0, maxItems);
}

function payloadFor(snapshot) {
  return {
    version: snapshot.version,
    projectPath: snapshot.projectPath,
    allowedRoot: snapshot.allowedRoot,
    allowedReadRoots: snapshot.allowedReadRoots,
    allowedWriteRoots: snapshot.allowedWriteRoots,
    allowRead: snapshot.allowRead,
    allowWrite: snapshot.allowWrite,
    allowedCommands: snapshot.allowedCommands,
    allowTests: snapshot.allowTests,
    allowInstall: snapshot.allowInstall,
    allowNetwork: snapshot.allowNetwork,
    allowedNetworkDomains: snapshot.allowedNetworkDomains,
    allowGit: snapshot.allowGit,
    allowedGitOperations: snapshot.allowedGitOperations,
    allowExternalSideEffects: snapshot.allowExternalSideEffects,
    allowSecrets: snapshot.allowSecrets,
    allowGitPush: snapshot.allowGitPush,
    blockedPaths: snapshot.blockedPaths,
    humanApproval: snapshot.humanApproval,
    maxBudget: snapshot.maxBudget,
    maxRuntimeMs: snapshot.maxRuntimeMs,
    maxLoopCount: snapshot.maxLoopCount,
    snapshotVersion: snapshot.snapshotVersion,
  };
}

function hashPayload(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');
}

function normalizePermissionSnapshot(input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const projectPath = path.resolve(text(source.projectPath));
  if (!projectPath || projectPath === path.resolve('.')) {
    throw new TypeError('permission snapshot projectPath is required');
  }
  const normalized = {
    version: 1,
    projectPath,
    allowedRoot: projectPath,
    allowedReadRoots: [projectPath],
    allowedWriteRoots: [projectPath],
    allowRead: bool(source.allowRead, true),
    allowWrite: bool(source.allowWrite, true),
    allowedCommands: list(source.allowedCommands, ['node --test', 'npm test'], 100, 200),
    allowTests: bool(source.allowTests, true),
    allowSecrets: bool(source.allowSecrets),
    allowNetwork: bool(source.allowNetwork),
    allowedNetworkDomains: list(source.allowedNetworkDomains, [], 100, 253),
    allowInstall: bool(source.allowInstall),
    allowGit: bool(source.allowGit, true),
    allowedGitOperations: list(source.allowedGitOperations, ['status', 'diff', 'branch', 'log'], 30, 40),
    allowExternalSideEffects: bool(source.allowExternalSideEffects),
    allowGitPush: bool(source.allowGitPush),
    blockedPaths: ['.env', '.env.*', '*.pem', '*.key', '*.p12', '*.pfx'],
    humanApproval: 'required',
    maxBudget: Number.isFinite(source.maxBudget) && source.maxBudget >= 0 ? source.maxBudget : 0,
    maxRuntimeMs: Number.isFinite(source.maxRuntimeMs) && source.maxRuntimeMs >= 1_000 ? source.maxRuntimeMs : 3_600_000,
    maxLoopCount: Number.isInteger(source.maxLoopCount) && source.maxLoopCount >= 1 ? source.maxLoopCount : 20,
    snapshotVersion: 1,
  };
  const snapshot = {
    ...normalized,
    snapshotId: /^ps-[a-f0-9-]{8,80}$/i.test(String(source.snapshotId || '')) ? String(source.snapshotId) : `ps-${crypto.randomUUID()}`,
    capturedAt: Number.isFinite(source.capturedAt) ? source.capturedAt : Date.now(),
  };
  const computedHash = hashPayload(payloadFor(snapshot));
  if (source.snapshotHash && source.snapshotHash !== computedHash) throw new TypeError('permission snapshot hash is invalid');
  snapshot.snapshotHash = computedHash;
  return deepFreeze(snapshot);
}

function buildPermissionSnapshot({ projectPath, settings = {}, now = Date.now() } = {}) {
  const autopilot = settings && typeof settings.autopilot === 'object' ? settings.autopilot : {};
  const safety = settings && typeof settings.safety === 'object' ? settings.safety : {};
  return normalizePermissionSnapshot({
    projectPath,
    allowRead: true,
    allowWrite: true,
    allowedCommands: safety.allowedCommands,
    allowTests: safety.allowTests,
    allowSecrets: safety.allowSecrets === true,
    allowNetwork: safety.allowNetwork === true,
    allowedNetworkDomains: safety.allowedNetworkDomains,
    allowInstall: safety.allowInstall === true,
    allowGit: safety.allowGit !== false,
    allowedGitOperations: safety.allowedGitOperations,
    allowExternalSideEffects: safety.allowExternalSideEffects === true,
    allowGitPush: safety.allowGitPush === true,
    maxBudget: autopilot.maxBudget,
    maxRuntimeMs: autopilot.maxRuntimeMs,
    maxLoopCount: autopilot.maxIterations,
    capturedAt: typeof now === 'function' ? now() : now,
  });
}

function verifyPermissionSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return false;
  return snapshot.snapshotHash === hashPayload(payloadFor(snapshot));
}

module.exports = { buildPermissionSnapshot, normalizePermissionSnapshot, verifyPermissionSnapshot };
