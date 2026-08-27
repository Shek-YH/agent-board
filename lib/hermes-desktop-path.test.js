'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { resolveHermesDesktopExe } = require('./hermes-desktop-path');

test('优先使用支持单实例和深链的本地 Hermes Desktop 构建', () => {
  const home = 'C:\\Users\\test';
  const result = resolveHermesDesktopExe({
    homedir: home,
    env: {},
    existsSync: file => file.endsWith('release\\win-unpacked\\Hermes.exe'),
  });

  assert.equal(
    result,
    `${home}\\AppData\\Local\\hermes\\hermes-agent\\apps\\desktop\\release\\win-unpacked\\Hermes.exe`,
  );
});

test('没有本地新构建时才回退到旧版安装路径', () => {
  const home = 'C:\\Users\\test';
  const result = resolveHermesDesktopExe({
    homedir: home,
    env: {},
    existsSync: file => file.endsWith('hermes-agent.exe'),
  });

  assert.equal(
    result,
    `${home}\\AppData\\Local\\Programs\\hermes-desktop\\hermes-agent.exe`,
  );
});

test('Hermes Desktop 支持 macOS 应用包路径', () => {
  const result = resolveHermesDesktopExe({
    platform: 'darwin',
    homedir: '/Users/test',
    env: {},
    existsSync: file => file === '/Users/test/Applications/Hermes.app/Contents/MacOS/Hermes',
  });
  assert.equal(result, '/Users/test/Applications/Hermes.app/Contents/MacOS/Hermes');
});
