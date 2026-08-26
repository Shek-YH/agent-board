'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MANIFESTS = [
  'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'pom.xml', 'composer.json',
];

function classifyProject(projectPath) {
  const rawPath = String(projectPath || '').trim();
  if (!rawPath) {
    return { kind: 'invalid', canonicalPath: '' };
  }
  const canonicalPath = path.resolve(rawPath);

  let stat;
  try { stat = fs.statSync(canonicalPath); } catch (error) {
    if (error.code === 'ENOENT') {
      return { kind: 'new', canonicalPath, exists: false, hasGit: false, manifests: [] };
    }
    return { kind: 'invalid', canonicalPath, error: error.message };
  }
  if (!stat.isDirectory()) return { kind: 'invalid', canonicalPath, exists: true };

  const entries = fs.readdirSync(canonicalPath, { withFileTypes: true });
  const hasGit = entries.some((entry) => entry.name === '.git');
  const manifests = MANIFESTS.filter((name) => entries.some((entry) => entry.name === name));
  if (hasGit) return { kind: 'existing', canonicalPath, exists: true, hasGit: true, manifests };
  if (manifests.length || entries.length) {
    return { kind: 'existing_unversioned', canonicalPath, exists: true, hasGit: false, manifests };
  }
  return { kind: 'new', canonicalPath, exists: true, hasGit: false, manifests: [] };
}

module.exports = { MANIFESTS, classifyProject };
