'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { resolveMarvisLauncher, resolveMarvisMain } = require('./marvis-desktop-path');

test('优先使用 MARVIS_LAUNCHER_EXE 覆盖路径', () => {
  assert.equal(
    resolveMarvisLauncher({
      env: { MARVIS_LAUNCHER_EXE: 'D:\\Marvis\\MarvisLauncher.exe' },
      existsSync: file => file === 'D:\\Marvis\\MarvisLauncher.exe',
      readRegistryCommand: () => '',
    }),
    'D:\\Marvis\\MarvisLauncher.exe',
  );
});

test('从 marvis 协议注册表命令解析启动器路径', () => {
  assert.equal(
    resolveMarvisLauncher({
      env: {},
      existsSync: file => file === 'F:\\Program Files\\Tencent\\Marvis\\MarvisLauncher.exe',
      readRegistryCommand: () => '    (Default)    REG_SZ    "F:\\Program Files\\Tencent\\Marvis\\MarvisLauncher.exe" "%1"',
    }),
    'F:\\Program Files\\Tencent\\Marvis\\MarvisLauncher.exe',
  );
});

test('从启动器所在安装根的版本目录解析 Marvis 主程序', () => {
  const launcher = 'D:\\Program Files\\Tencent\\Marvis\\Application\\MarvisLauncher.exe';
  const main = 'D:\\Program Files\\Tencent\\Marvis\\Application\\3.2.1\\Marvis.exe';
  const result = resolveMarvisMain({
    env: { MARVIS_LAUNCHER_EXE: launcher },
    existsSync: file => file === launcher || file === main,
    readdirSync: dir => dir.endsWith('\\Application')
      ? [{ name: '3.2.1', isDirectory: () => true }]
      : [],
    readRegistryCommand: () => '',
  });
  assert.equal(result, main);
});
