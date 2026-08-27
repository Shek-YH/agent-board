'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MARKER_NAME = '.runtime.json';

function getRuntimeMarkerPath(dataDir) {
  return path.join(dataDir, MARKER_NAME);
}

function writeRuntimeMarker(identity, { dataDir, markerPath } = {}) {
  const target = markerPath || (dataDir && getRuntimeMarkerPath(dataDir));
  if (!target || !identity) return false;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tempPath = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify({ schemaVersion: 1, ...identity }), 'utf8');
    fs.renameSync(tempPath, target);
    return true;
  } catch {
    return false;
  }
}

function readRuntimeMarker({ dataDir, markerPath } = {}) {
  const target = markerPath || (dataDir && getRuntimeMarkerPath(dataDir));
  if (!target) return null;
  try {
    const value = JSON.parse(fs.readFileSync(target, 'utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function matchesRuntimeIdentity(marker, identity) {
  if (!marker || !identity) return false;
  return ['pid', 'port', 'serverEntry', 'serverEntrySha256'].every((key) => {
    if (identity[key] === undefined || identity[key] === null) return true;
    return marker[key] === identity[key];
  });
}

function clearRuntimeMarker(identity, { dataDir, markerPath } = {}) {
  const target = markerPath || (dataDir && getRuntimeMarkerPath(dataDir));
  if (!target) return false;
  const current = readRuntimeMarker({ markerPath: target });
  if (identity && !matchesRuntimeIdentity(current, identity)) return false;
  try {
    fs.unlinkSync(target);
    return true;
  } catch (error) {
    return error.code === 'ENOENT';
  }
}

module.exports = {
  getRuntimeMarkerPath,
  writeRuntimeMarker,
  readRuntimeMarker,
  matchesRuntimeIdentity,
  clearRuntimeMarker,
};
