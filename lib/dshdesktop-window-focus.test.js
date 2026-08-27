'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const installRoot = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
  'Programs', 'DSH Desktop', 'resources', 'app.asar.unpacked', 'lib',
);
function findLatestRuntimeName(root) {
  if (!fs.existsSync(root)) return null;
  const candidates = fs.readdirSync(root)
    .filter((name) => /^electron-runtime(?:-[^/\\]+)?\.js$/i.test(name))
    .map((name) => {
      let mtimeMs = 0;
      try { mtimeMs = fs.statSync(path.join(root, name)).mtimeMs; } catch { /* ignore */ }
      return { name, mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name, undefined, { sensitivity: 'base' }));
  return candidates[0] ? candidates[0].name : null;
}

function readOptional(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

function getPatchSkipReason(source, patchPattern, missingMessage) {
  if (source == null) return missingMessage;
  return patchPattern.test(source)
    ? false
    : 'DSH Desktop 已安装但 Agent Board 补丁未应用，跳过补丁耦合测试';
}

const runtimeName = findLatestRuntimeName(installRoot);
const runtimePath = runtimeName ? path.join(installRoot, runtimeName) : '';
const mainPath = path.join(installRoot, 'main.js');
const mainSource = readOptional(mainPath);
const runtimeSource = runtimePath ? readOptional(runtimePath) : null;
const mainPatch = /if \(!runtime\.dispatchSessionOpen\(request\)\) return;\s+runtime\.show\(\);/;
const runtimePatch = /app\.focus\(\{ steal: true \}\)/;
const mainSkipReason = getPatchSkipReason(
  mainSource,
  mainPatch,
  'DSH Desktop main.js 未安装，跳过补丁耦合测试',
);
const runtimeSkipReason = getPatchSkipReason(
  runtimeSource,
  runtimePatch,
  'DSH Desktop electron runtime 未安装，跳过补丁耦合测试',
);

test('DSH Desktop 补丁检测区分未安装与已安装但未打补丁', () => {
  assert.equal(getPatchSkipReason(null, /patched/, 'missing'), 'missing');
  assert.equal(getPatchSkipReason('original build', /patched/, 'missing'), 'DSH Desktop 已安装但 Agent Board 补丁未应用，跳过补丁耦合测试');
  assert.equal(getPatchSkipReason('patched build', /patched/, 'missing'), false);
});

test('DSH Desktop re-reveals the window when flushing a queued session request', { skip: mainSkipReason }, () => {
  assert.match(mainSource, mainPatch);
});

test('DSH Desktop uses the Windows foreground activation path', { skip: runtimeSkipReason }, () => {
  assert.match(runtimeSource, runtimePatch);
  assert.match(runtimeSource, /setAlwaysOnTop\(true/);
});
