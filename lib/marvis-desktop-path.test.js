'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { resolveMarvisLauncher } = require('./marvis-desktop-path');

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
