'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ARRAY_FIELDS = [
  'sessions', 'messages', 'hidden', 'manual_status', 'todoTasks', 'prompts',
  'promptGroups', 'indexEntries', 'categories', 'entries',
];

function countArrays(snapshot) {
  const value = snapshot && typeof snapshot === 'object' ? snapshot : {};
  return Object.fromEntries(ARRAY_FIELDS.map((field) => [field, Array.isArray(value[field]) ? value[field].length : 0]));
}

function inspectSnapshotFile(filePath) {
  const bytes = fs.readFileSync(filePath);
  let snapshot;
  try { snapshot = JSON.parse(bytes.toString('utf8')); } catch (error) {
    throw new Error(`invalid JSON snapshot: ${error.message}`);
  }
  return {
    path: filePath,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
    counts: countArrays(snapshot),
  };
}

function mergeCounts(...counts) {
  return Object.fromEntries(ARRAY_FIELDS.map((field) => [field, counts.reduce((sum, item) => sum + (item[field] || 0), 0)]));
}

function dryRunMigration({ dataPath, userDataPath, target }) {
  const data = inspectSnapshotFile(dataPath);
  const userData = inspectSnapshotFile(userDataPath);
  const actualCounts = mergeCounts(data.counts, userData.counts);
  const targetCounts = countArrays(target);
  const mismatches = ARRAY_FIELDS.filter((field) => actualCounts[field] !== targetCounts[field]);
  return {
    ok: mismatches.length === 0,
    wouldWrite: false,
    reason: mismatches.length ? `count mismatch: ${mismatches.join(', ')}` : null,
    before: { data, userData, counts: actualCounts },
    target: { counts: targetCounts },
  };
}

function rollbackFiles({ backupDir, dataPath, userDataPath }) {
  for (const filePath of [dataPath, userDataPath]) {
    const name = filePath.split(/[\\/]/).pop();
    const candidates = fs.readdirSync(backupDir)
      .filter((item) => item === name || item.startsWith(`${name}.`))
      .sort()
      .reverse();
    if (!candidates.length) throw new Error(`missing migration backup: ${name}`);
    fs.copyFileSync(path.join(backupDir, candidates[0]), filePath);
  }
}

module.exports = { ARRAY_FIELDS, countArrays, inspectSnapshotFile, dryRunMigration, rollbackFiles };
