'use strict';

const fs = require('node:fs');
const path = require('node:path');

const unpackedDir = path.resolve(process.argv[2] || 'dist/win-unpacked');
const resourcesDir = path.join(unpackedDir, 'resources');
const backendDir = path.join(resourcesDir, 'backend');
const required = [
  'resources/backend/server.js',
  'resources/backend/lib/store.js',
  'resources/backend/public/index.html',
  'resources/backend/tools/wf.dll',
  'resources/runtime/node.exe',
];
const forbiddenText = [
  'C:\\Users\\Administrator\\WorkBuddy\\2026-08-20-03-52-10',
  'C:\\Users\\Administrator\\AppData',
];

function walk(directory) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(entryPath));
    else files.push(entryPath);
  }
  return files;
}

function fail(message) {
  console.error(`Package verification failed: ${message}`);
  process.exitCode = 1;
}

for (const relativePath of required) {
  if (!fs.existsSync(path.join(unpackedDir, relativePath))) fail(`missing ${relativePath}`);
}

for (const filePath of walk(backendDir)) {
  const relativePath = path.relative(backendDir, filePath);
  const normalized = relativePath.replaceAll('\\', '/');
  if (/(^|\/)node_modules(\/|$)/.test(normalized)
    || /(^|\/)docs(\/|$)/.test(normalized)
    || /\.test\.js$/.test(normalized)
    || /\.bak$/.test(normalized)) {
    fail(`unexpected development file ${normalized}`);
  }
  if (/\.(?:js|json|html|css|bat|ps1|md|txt)$/.test(normalized)) {
    const content = fs.readFileSync(filePath, 'utf8');
    for (const marker of forbiddenText) {
      if (content.includes(marker)) fail(`development path leaked in ${normalized}`);
    }
  }
}

if (process.exitCode !== 1) console.log(`Package verification passed: ${unpackedDir}`);
