'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const detect = require('./detect');
const deepseekPath = require('./deepseek-desktop-path');
const marvisPath = require('./marvis-desktop-path');
const deepseek = require('./adapters/deepseek');
const marvis = require('./adapters/marvis');

function tempConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-v39-'));
  return { dir, file: path.join(dir, 'tool-paths.json') };
}

test('v3.9 path overrides normalize legacy values and preserve CLI/Desktop variants', () => {
  const { dir, file } = tempConfig();
  try {
    fs.writeFileSync(file, JSON.stringify({
      codex: ['D:\\tools\\codex.cmd'],
      deepseek: { cli: ['D:\\tools\\dsh.cmd'], desktop: ['D:\\deepseek\\DSH Desktop\\DSH Desktop.exe'] },
    }));
    assert.deepEqual(detect.loadUserOverrides(file), {
      codex: { cli: ['D:\\tools\\codex.cmd'], desktop: [] },
      deepseek: { cli: ['D:\\tools\\dsh.cmd'], desktop: ['D:\\deepseek\\DSH Desktop\\DSH Desktop.exe'] },
    });
    const next = detect.saveDesktopUserOverride('codex', 'D:\\Apps\\Codex.exe', file);
    assert.deepEqual(next.codex, { cli: ['D:\\tools\\codex.cmd'], desktop: ['D:\\Apps\\Codex.exe'] });
    const cleared = detect.saveDesktopUserOverride('codex', '', file);
    assert.deepEqual(cleared.codex, { cli: ['D:\\tools\\codex.cmd'], desktop: [] });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('desktopProbe consumes a manual Desktop override without affecting CLI override', () => {
  const desktop = 'D:\\deepseek\\DSH Desktop\\DSH Desktop.exe';
  const result = detect.probeAgent(deepseek, {
    platform: 'win32',
    env: {},
    userOverrides: { deepseek: { cli: [], desktop: [desktop] } },
    existsSync: (value) => value === desktop,
    findCommandFn: () => null,
    tryVersionFn: () => '',
  });
  assert.equal(result.cliInstalled, false);
  assert.equal(result.desktopInstalled, true);
  assert.equal(result.desktopSource, 'override');
  assert.equal(result.desktopExecutablePath, desktop);
});

test('DeepSeek resolver returns the existing manual path and empty string when nothing exists', () => {
  const desktop = 'D:\\deepseek\\DSH Desktop\\DSH Desktop.exe';
  assert.equal(deepseekPath.resolveDeepSeekDesktopExe({
    platform: 'win32', env: {}, homedir: 'C:\\Users\\test',
    userOverrides: { deepseek: { cli: [], desktop: [desktop] } },
    existsSync: (value) => value === desktop,
  }), desktop);
  assert.equal(deepseekPath.resolveDeepSeekDesktopExe({
    platform: 'win32', env: {}, homedir: 'C:\\Users\\test',
    userOverrides: {}, existsSync: () => false,
  }), '');
});

test('Marvis probe and launch resolver recognize Program Files(x86) without Tencent subdirectory', () => {
  const desktop = 'C:\\Program Files (x86)\\Marvis\\Application\\1.60.2300.174\\Marvis.exe';
  const env = { 'ProgramFiles(x86)': 'C:\\Program Files (x86)', ProgramFiles: 'C:\\Program Files' };
  const existsSync = (value) => value === desktop;
  const probe = detect.probeAgent(marvis, {
    platform: 'win32', env, userOverrides: {}, existsSync,
    findCommandFn: () => null,
    readdirSync: (dir) => dir === 'C:\\Program Files (x86)\\Marvis\\Application'
      ? [{ name: '1.60.2300.174', isDirectory: () => true }]
      : [],
  });
  assert.equal(probe.installed, true);
  assert.equal(probe.executablePath, desktop);
  assert.equal(probe.source, 'builtin');
  assert.equal(marvisPath.resolveMarvisMain({
    platform: 'win32', env, userOverrides: {}, existsSync,
    readdirSync: (dir) => dir.endsWith('\\Application')
      ? [{ name: '1.60.2300.174', isDirectory: () => true }]
      : [],
    readRegistryCommand: () => '',
  }), desktop);
});
