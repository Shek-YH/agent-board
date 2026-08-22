'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { expandPath, probePathList } = require('./detect');

test('expandPath 展开 %ENV_VAR%', () => {
  const out = expandPath('%FOO%\\bar.exe', { env: { FOO: 'C:\\Test' } });
  assert.equal(out, 'C:\\Test\\bar.exe');
});

test('expandPath 未定义的变量原样保留', () => {
  const out = expandPath('%NOT_SET%\\bar.exe', { env: {} });
  assert.equal(out, '%NOT_SET%\\bar.exe');
});

test('expandPath 展开开头的 ~', () => {
  const out = expandPath('~\\.foo\\bar.exe', { home: 'C:\\Users\\test' });
  assert.equal(out, path.join('C:\\Users\\test', '.foo', 'bar.exe'));
});

test('probePathList 返回第一个真实存在的路径', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-detect-'));
  const real = path.join(dir, 'real.exe');
  fs.writeFileSync(real, '');
  const hit = probePathList([path.join(dir, 'missing.exe'), real], {});
  assert.equal(hit, real);
});

test('probePathList 全不存在返回 null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-detect-'));
  const hit = probePathList([path.join(dir, 'missing.exe')], {});
  assert.equal(hit, null);
});

const { queryUninstallEntries, probeRegistryApp } = require('./detect');

test('queryUninstallEntries 解析 reg query /s 输出', () => {
  const fakeStdout = [
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ZCode',
    '    DisplayName    REG_SZ    ZCode',
    '',
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Other',
    '    DisplayName    REG_SZ    Some Other App',
    '',
  ].join('\r\n');
  const fakeRunReg = () => ({ status: 0, stdout: fakeStdout });
  const entries = queryUninstallEntries('HKCU\\...', fakeRunReg);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].displayName, 'ZCode');
  assert.equal(entries[1].displayName, 'Some Other App');
});

test('probeRegistryApp 按前缀匹配命中', () => {
  const fakeStdout = [
    'HKEY_CURRENT_USER\\...\\Uninstall\\ZCode',
    '    DisplayName    REG_SZ    ZCode',
    '',
  ].join('\r\n');
  const fakeRunReg = () => ({ status: 0, stdout: fakeStdout });
  const r = probeRegistryApp(['ZCode'], fakeRunReg);
  assert.equal(r.found, true);
  assert.equal(r.displayName, 'ZCode');
});

test('probeRegistryApp 查不到返回 found:false', () => {
  const fakeRunReg = () => ({ status: 0, stdout: '' });
  const r = probeRegistryApp(['NotInstalledApp'], fakeRunReg);
  assert.equal(r.found, false);
});
