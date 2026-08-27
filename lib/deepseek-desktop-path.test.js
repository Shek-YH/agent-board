'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { resolveDeepSeekDesktopExe } = require('./deepseek-desktop-path');

test('DeepSeek Desktop 优先使用环境变量路径', () => {
  const result = resolveDeepSeekDesktopExe({
    env: { DEEPSEEK_DESKTOP_EXE: 'D:\\Apps\\DSH Desktop.exe' },
    homedir: 'C:\\Users\\test',
    existsSync: file => file === 'D:\\Apps\\DSH Desktop.exe',
  });
  assert.equal(result, 'D:\\Apps\\DSH Desktop.exe');
});

test('DeepSeek Desktop 回退到用户默认安装路径', () => {
  const home = 'C:\\Users\\test';
  const result = resolveDeepSeekDesktopExe({
    env: {},
    homedir: home,
    existsSync: file => file.endsWith('DSH Desktop\\DSH Desktop.exe'),
  });
  assert.equal(result, home + '\\AppData\\Local\\Programs\\DSH Desktop\\DSH Desktop.exe');
});

test('DeepSeek Desktop 支持 macOS 应用包路径', () => {
  const result = resolveDeepSeekDesktopExe({
    platform: 'darwin',
    env: {},
    homedir: '/Users/test',
    existsSync: file => file === '/Users/test/Applications/DSH Desktop.app/Contents/MacOS/DSH Desktop',
  });
  assert.equal(result, '/Users/test/Applications/DSH Desktop.app/Contents/MacOS/DSH Desktop');
});
