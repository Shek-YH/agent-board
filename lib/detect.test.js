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

const { probeAgent, probeAll } = require('./detect');

test('probeAgent 命中用户覆盖路径时 source=override', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-detect-'));
  const overridePath = path.join(dir, 'pi.exe');
  fs.writeFileSync(overridePath, '');
  const adapter = { ID: 'pi', detect: { tier: 'cli', probe: { kind: 'path', win32: [] } } };
  const result = probeAgent(adapter, { userOverrides: { pi: [overridePath] } });
  assert.equal(result.installed, true);
  assert.equal(result.source, 'override');
  assert.equal(result.path, overridePath);
});

test('probeAgent 无覆盖、命中内置路径时 source=builtin', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-detect-'));
  const builtinPath = path.join(dir, 'claude.exe');
  fs.writeFileSync(builtinPath, '');
  const adapter = { ID: 'claude', detect: { tier: 'cli', probe: { kind: 'path', win32: [builtinPath] } } };
  const result = probeAgent(adapter, { userOverrides: {} });
  assert.equal(result.installed, true);
  assert.equal(result.source, 'builtin');
});

test('probeAgent 都探测不到时 installed=false', () => {
  const adapter = { ID: 'claude', detect: { tier: 'cli', probe: { kind: 'path', win32: ['C:\\definitely\\not\\exist.exe'] } } };
  const result = probeAgent(adapter, { userOverrides: {} });
  assert.equal(result.installed, false);
});

test('probeAgent 没有 detect 配置时返回 tier:unknown', () => {
  const adapter = { ID: 'nodetect' };
  const result = probeAgent(adapter, {});
  assert.equal(result.tier, 'unknown');
  assert.equal(result.installed, false);
});

test('probeAgent registry 命中时也算已安装', () => {
  const fakeRunReg = () => ({ status: 0, stdout: 'HKEY_CURRENT_USER\\...\\ZCode\r\n    DisplayName    REG_SZ    ZCode\r\n' });
  const adapter = {
    ID: 'zcode',
    detect: {
      tier: 'gui',
      probe: { kind: 'registry', win32: ['C:\\not\\exist.exe'], registryHints: { displayNamePrefixes: ['ZCode'] } },
    },
  };
  const result = probeAgent(adapter, { userOverrides: {}, runReg: fakeRunReg });
  assert.equal(result.installed, true);
  assert.equal(result.registryName, 'ZCode');
});

test('probeAll 对多个 adapter 各自探测，按 ID 建 map', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-detect-'));
  const p1 = path.join(dir, 'a.exe'); fs.writeFileSync(p1, '');
  const adapters = [
    { ID: 'a', detect: { tier: 'cli', probe: { kind: 'path', win32: [p1] } } },
    { ID: 'b', detect: { tier: 'cli', probe: { kind: 'path', win32: ['C:\\not\\exist.exe'] } } },
  ];
  const result = await probeAll(adapters, { userOverrides: {} });
  assert.equal(result.a.installed, true);
  assert.equal(result.b.installed, false);
});

test('probeAgent 命中安装后真正跑 verify.cmd 取到版本号（真实 spawnSync 路径）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-detect-'));
  const builtinPath = path.join(dir, 'claude.exe');
  fs.writeFileSync(builtinPath, '');
  const adapter = {
    ID: 'claude',
    detect: {
      tier: 'cli',
      probe: { kind: 'path', win32: [builtinPath] },
      verify: { cmd: 'node --version' },
    },
  };
  const result = probeAgent(adapter, { userOverrides: {} });
  assert.equal(result.installed, true);
  assert.equal(typeof result.version, 'string');
  assert.notEqual(result.version, '');
});

test('probeAgent 覆盖路径和内置路径都存在时，优先用覆盖路径（source 与 path 都指向覆盖）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-detect-'));
  const overridePath = path.join(dir, 'override.exe');
  const builtinPath = path.join(dir, 'builtin.exe');
  fs.writeFileSync(overridePath, '');
  fs.writeFileSync(builtinPath, '');
  const adapter = { ID: 'pi', detect: { tier: 'cli', probe: { kind: 'path', win32: [builtinPath] } } };
  const result = probeAgent(adapter, { userOverrides: { pi: [overridePath] } });
  assert.equal(result.source, 'override');
  assert.equal(result.path, overridePath);
});

test('8 个 adapter 的 detect 配置符合基本 schema', () => {
  const adapters = [
    require('./adapters/claude'),
    require('./adapters/codex'),
    require('./adapters/pi'),
    require('./adapters/deepseek'),
    require('./adapters/workbuddy'),
    require('./adapters/zcode'),
    require('./adapters/doubao'),
    require('./adapters/marvis'),
  ];
  assert.equal(adapters.length, 8);
  const adapterFiles = fs.readdirSync(path.join(__dirname, 'adapters')).filter((f) => f.endsWith('.js'));
  assert.equal(adapters.length, adapterFiles.length, `lib/adapters/ 目录下有 ${adapterFiles.length} 个文件，但测试里只手动列了 ${adapters.length} 个 — 是不是漏加了新 adapter？`);
  for (const a of adapters) {
    assert.ok(a.detect, `${a.ID} 缺少 detect 导出`);
    assert.ok(['cli', 'gui'].includes(a.detect.tier), `${a.ID}.detect.tier 必须是 cli 或 gui`);
    assert.ok(a.detect.probe && Array.isArray(a.detect.probe.win32), `${a.ID}.detect.probe.win32 必须是数组`);
    assert.ok(a.detect.identityGuard && typeof a.detect.identityGuard.description === 'string' && a.detect.identityGuard.description, `${a.ID}.detect.identityGuard.description 缺失`);
    assert.ok(Array.isArray(a.detect.install && a.detect.install.methods), `${a.ID}.detect.install.methods 必须是数组（可以为空）`);
    if (a.detect.probe.kind === 'registry') {
      assert.ok(
        Array.isArray(a.detect.probe.registryHints && a.detect.probe.registryHints.displayNamePrefixes) &&
        a.detect.probe.registryHints.displayNamePrefixes.length > 0,
        `${a.ID}.detect.probe.registryHints.displayNamePrefixes 必须是非空数组（kind:'registry' 时必需）`
      );
    }
  }
});

const { pickMethod } = require('./detect');

test('pickMethod win32 优先选带 win32 的 script', () => {
  const methods = [
    { kind: 'script', posix: 'curl x | sh' },
    { kind: 'script', win32: 'irm x | iex' },
    { kind: 'npm', pkg: 'foo' },
  ];
  const m = pickMethod(methods, 'win32');
  assert.equal(m.kind, 'script');
  assert.equal(m.win32, 'irm x | iex');
});

test('pickMethod win32 上跳过只有 posix 的 script，落到 npm', () => {
  const methods = [
    { kind: 'script', posix: 'curl x | sh' },
    { kind: 'npm', pkg: 'foo' },
  ];
  const m = pickMethod(methods, 'win32');
  assert.equal(m.kind, 'npm');
});

test('pickMethod 非 win32 平台选 posix script', () => {
  const methods = [
    { kind: 'script', posix: 'curl x | sh' },
    { kind: 'npm', pkg: 'foo' },
  ];
  const m = pickMethod(methods, 'darwin');
  assert.equal(m.kind, 'script');
  assert.equal(m.posix, 'curl x | sh');
});

test('pickMethod 非 win32 平台跳过 winget', () => {
  const methods = [
    { kind: 'winget', id: 'Some.App' },
    { kind: 'npm', pkg: 'foo' },
  ];
  const m = pickMethod(methods, 'linux');
  assert.equal(m.kind, 'npm');
});

test('pickMethod 只有 download 时返回 null（本轮不处理 download）', () => {
  const m = pickMethod([{ kind: 'download', url: 'https://x' }], 'win32');
  assert.equal(m, null);
});

test('pickMethod 空数组/undefined 返回 null', () => {
  assert.equal(pickMethod([], 'win32'), null);
  assert.equal(pickMethod(undefined, 'win32'), null);
});
