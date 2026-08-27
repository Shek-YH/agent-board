'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { resolveClaudeDesktopExe } = require('./claude-desktop-path');

test('Claude Desktop 使用 WindowsApps 中已验证的 MSIX 主程序路径', () => {
  const expected = 'C:\\Program Files\\WindowsApps\\Claude_1.37937.1.0_x64__pzs8sxrjxfjjc\\app\\claude.exe';
  const result = resolveClaudeDesktopExe({
    platform: 'win32',
    env: { PROGRAMFILES: 'C:\\Program Files' },
    existsSync: (file) => file === expected,
    runReg: () => ({ status: 1, stdout: '' }),
  });

  assert.equal(result, expected);
});

test('Claude Desktop 无法枚举 WindowsApps 时通过注册表解析版本目录', () => {
  const root = 'C:\\Program Files\\WindowsApps\\Claude_1.400.0.0_x64__pzs8sxrjxfjjc';
  const expected = `${root}\\app\\claude.exe`;
  const packageKey = 'HKEY_CURRENT_USER\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppModel\\Repository\\Packages\\Claude_1.400.0.0_x64__pzs8sxrjxfjjc';
  const calls = [];
  const result = resolveClaudeDesktopExe({
    platform: 'win32',
    env: { PROGRAMFILES: 'C:\\Program Files' },
    existsSync: (file) => file === expected,
    runReg: (args) => {
      calls.push(args);
      if (args.includes('/k')) return { status: 0, stdout: `${packageKey}\r\n` };
      return { status: 0, stdout: `    PackageRootFolder    REG_SZ    ${root}\r\n` };
    },
  });

  assert.equal(result, expected);
  assert.ok(calls.some((args) => args.includes('/k')));
  assert.ok(calls.some((args) => args.includes('PackageRootFolder')));
});
