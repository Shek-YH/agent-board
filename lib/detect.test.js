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

test('queryUninstallEntries runReg 返回 null（reg.exe 缺失）时返回空数组且不抛异常', () => {
  const fakeRunReg = () => null;
  assert.doesNotThrow(() => {
    const entries = queryUninstallEntries('HKCU\\...', fakeRunReg);
    assert.deepEqual(entries, []);
  });
});

test('queryUninstallEntries status 非 0（如拒绝访问）时返回空数组且不抛异常', () => {
  const fakeRunReg = () => ({ status: 1, stdout: '' });
  assert.doesNotThrow(() => {
    const entries = queryUninstallEntries('HKLM\\...', fakeRunReg);
    assert.deepEqual(entries, []);
  });
});

test('queryUninstallEntries 兼容 REG_EXPAND_SZ', () => {
  const fakeStdout = [
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ZCode',
    '    DisplayName    REG_EXPAND_SZ    ZCode',
    '',
  ].join('\r\n');
  const fakeRunReg = () => ({ status: 0, stdout: fakeStdout });
  const entries = queryUninstallEntries('HKCU\\...', fakeRunReg);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].displayName, 'ZCode');
});

test('probeRegistryApp 真正扫描全部 3 个 hive（前两个查不到，第三个才命中）', () => {
  const hiveStdout = {
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall': '',
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall': '',
    'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall': [
      'HKEY_LOCAL_MACHINE\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ZCode',
      '    DisplayName    REG_SZ    ZCode',
      '',
    ].join('\r\n'),
  };
  const fakeRunReg = (args) => ({ status: 0, stdout: hiveStdout[args[1]] || '' });
  const r = probeRegistryApp(['ZCode'], fakeRunReg);
  assert.equal(r.found, true);
  assert.equal(r.displayName, 'ZCode');
});

test('probeRegistryApp 前缀匹配到比前缀更长的 displayName', () => {
  const fakeStdout = [
    'HKEY_CURRENT_USER\\...\\Uninstall\\ZCode',
    '    DisplayName    REG_SZ    ZCode CLI 2.1.0',
    '',
  ].join('\r\n');
  const fakeRunReg = () => ({ status: 0, stdout: fakeStdout });
  const r = probeRegistryApp(['ZCode'], fakeRunReg);
  assert.equal(r.found, true);
  assert.equal(r.displayName, 'ZCode CLI 2.1.0');
});

const { loadUserOverrides } = require('./detect');

test('loadUserOverrides 文件不存在返回空对象', () => {
  const p = path.join(os.tmpdir(), 'ab-detect-missing-' + Date.now() + '.json');
  assert.deepEqual(loadUserOverrides(p), {});
});

test('loadUserOverrides 解析数组和单字符串两种写法', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-detect-'));
  const p = path.join(dir, 'tool-paths.json');
  fs.writeFileSync(p, JSON.stringify({ pi: ['D:\\Tools\\pi.exe'], codex: 'D:\\Tools\\codex.exe' }));
  const out = loadUserOverrides(p);
  assert.deepEqual(out.pi, ['D:\\Tools\\pi.exe']);
  assert.deepEqual(out.codex, ['D:\\Tools\\codex.exe']);
});

test('loadUserOverrides 坏 JSON 不崩溃，返回空对象', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-detect-'));
  const p = path.join(dir, 'tool-paths.json');
  fs.writeFileSync(p, '{ not valid json');
  assert.deepEqual(loadUserOverrides(p), {});
});

test('loadUserOverrides 顶层是 JSON 数组时返回空对象', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-detect-'));
  const p = path.join(dir, 'tool-paths.json');
  fs.writeFileSync(p, JSON.stringify(['x', 'y']));
  assert.deepEqual(loadUserOverrides(p), {});
});
