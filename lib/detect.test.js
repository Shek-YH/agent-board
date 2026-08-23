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

test('pickMethod 对 codex 真实数据在 win32 上选中 script 而不是排在它前面的 npm（回归测试）', () => {
  const codex = require('./adapters/codex');
  const m = pickMethod(codex.detect.install.methods, 'win32');
  assert.equal(m.kind, 'script');
});

const { installAgent } = require('./detect');

// 收集 onProgress 汇报的每一步，方便断言
function collectSteps() {
  const steps = [];
  const onProgress = (step, detail) => steps.push({ step, detail });
  return { steps, onProgress };
}

test('installAgent 命中 blockedRegions 时直接 blocked，不执行任何命令', () => {
  let ran = false;
  const adapter = {
    ID: 'claude',
    detect: {
      tier: 'cli',
      network: { blockedRegions: { 'zh-CN': '需要代理，没有镜像可用' } },
      install: { methods: [{ kind: 'npm', pkg: 'foo' }] },
    },
  };
  const { steps, onProgress } = collectSteps();
  const r = installAgent(adapter, onProgress, { runCmd: () => { ran = true; return { status: 0 }; } });
  assert.equal(r.ok, false);
  assert.equal(steps[0].step, 'blocked');
  assert.equal(steps[0].detail.message, '需要代理，没有镜像可用');
  assert.equal(ran, false, '被墙拦截时不应该执行任何命令');
});

test('installAgent Node 版本不满足时 deps-missing，不执行任何命令', () => {
  let ran = false;
  const adapter = {
    ID: 'codex',
    detect: {
      tier: 'cli',
      requirements: { node: '>=22' },
      install: { methods: [{ kind: 'npm', pkg: 'foo' }] },
    },
  };
  const { steps, onProgress } = collectSteps();
  const r = installAgent(adapter, onProgress, {
    runCmd: () => { ran = true; return { status: 0 }; },
    nodeVersion: 'v18.20.0',
  });
  assert.equal(r.ok, false);
  assert.equal(steps[0].step, 'deps-missing');
  assert.equal(steps[0].detail.need, '>=22');
  assert.equal(steps[0].detail.have, 'v18.20.0');
  assert.equal(ran, false);
});

test('installAgent Node 版本满足时不拦截（继续往下走到执行阶段）', () => {
  const adapter = {
    ID: 'codex',
    detect: {
      tier: 'cli',
      requirements: { node: '>=22' },
      install: { methods: [{ kind: 'npm', pkg: 'foo' }] },
      verify: { cmd: 'codex --version' },
    },
  };
  const { steps, onProgress } = collectSteps();
  installAgent(adapter, onProgress, {
    runCmd: () => ({ status: 0, stdout: '' }),
    nodeVersion: 'v24.1.0',
    tryVersionFn: () => 'codex 1.2.3',
  });
  assert.ok(steps.every((s) => s.step !== 'deps-missing'), 'Node 24 满足 >=22，不该报缺依赖');
});

test('installAgent 没有可用方法时报 no-method', () => {
  const adapter = {
    ID: 'x',
    detect: { tier: 'cli', install: { methods: [{ kind: 'download', url: 'https://x' }] } },
  };
  const { steps, onProgress } = collectSteps();
  const r = installAgent(adapter, onProgress, { runCmd: () => ({ status: 0 }), platform: 'win32' });
  assert.equal(r.ok, false);
  assert.equal(steps[0].step, 'no-method');
});

const { satisfiesNodeVersion, methodToCommand } = require('./detect');

test('satisfiesNodeVersion 各种边界', () => {
  assert.equal(satisfiesNodeVersion('v24.1.0', '>=22'), true);
  assert.equal(satisfiesNodeVersion('v22.0.0', '>=22'), true);
  assert.equal(satisfiesNodeVersion('v21.9.9', '>=22'), false);
  assert.equal(satisfiesNodeVersion('v22.19.0', '>=22.19.0'), true, '完全相等算满足');
  assert.equal(satisfiesNodeVersion('v22.18.5', '>=22.19.0'), false);
  assert.equal(satisfiesNodeVersion('v22.20.0', '>=22.19.0'), true);
  assert.equal(satisfiesNodeVersion('v18.0.0', undefined), true, '没要求就放行');
  assert.equal(satisfiesNodeVersion('v18.0.0', '^22'), true, '看不懂的写法放行，不误挡用户');
});

test('methodToCommand 拼 npm 命令（带 flags）', () => {
  const cmd = methodToCommand({ kind: 'npm', pkg: '@earendil-works/pi-coding-agent', flags: ['--ignore-scripts'] }, 'win32');
  assert.equal(cmd, 'npm install -g --ignore-scripts @earendil-works/pi-coding-agent');
});

test('methodToCommand 拼 npm 命令（无 flags）', () => {
  assert.equal(methodToCommand({ kind: 'npm', pkg: '@openai/codex' }, 'win32'), 'npm install -g @openai/codex');
});

test('methodToCommand script 按平台取对应字段', () => {
  const m = { kind: 'script', win32: 'irm a | iex', posix: 'curl a | sh' };
  assert.equal(methodToCommand(m, 'win32'), 'irm a | iex');
  assert.equal(methodToCommand(m, 'darwin'), 'curl a | sh');
});

test('methodToCommand 拼 winget 命令', () => {
  const cmd = methodToCommand({ kind: 'winget', id: 'Some.App', flags: ['--accept-package-agreements'] }, 'win32');
  assert.equal(cmd, 'winget install --id Some.App --accept-package-agreements');
});

test('installAgent 成功路径：installing → verifying → done', () => {
  const adapter = {
    ID: 'pi',
    detect: {
      tier: 'cli',
      install: { methods: [{ kind: 'npm', pkg: '@earendil-works/pi-coding-agent', flags: ['--ignore-scripts'] }] },
      verify: { cmd: 'pi --version' },
      afterInstall: { tellUser: ['装完可能要点刷新'] },
    },
  };
  const { steps, onProgress } = collectSteps();
  const r = installAgent(adapter, onProgress, {
    platform: 'win32',
    runCmd: (cmd) => {
      assert.equal(cmd, 'npm install -g --ignore-scripts @earendil-works/pi-coding-agent');
      return { status: 0, stdout: 'added 1 package' };
    },
    tryVersionFn: () => '0.84.2',
  });
  assert.equal(r.ok, true);
  assert.equal(r.version, '0.84.2');
  assert.deepEqual(steps.map((s) => s.step), ['installing', 'verifying', 'done']);
  assert.deepEqual(steps[2].detail.tellUser, ['装完可能要点刷新']);
});

test('installAgent 安装命令失败：failed，且不继续跑 verify', () => {
  let verifyCalled = false;
  const adapter = {
    ID: 'pi',
    detect: {
      tier: 'cli',
      install: { methods: [{ kind: 'npm', pkg: 'foo' }] },
      verify: { cmd: 'pi --version' },
    },
  };
  const { steps, onProgress } = collectSteps();
  const r = installAgent(adapter, onProgress, {
    platform: 'win32',
    runCmd: () => ({ status: 1, stderr: 'npm ERR! 404 Not Found' }),
    tryVersionFn: () => { verifyCalled = true; return '1.0.0'; },
  });
  assert.equal(r.ok, false);
  assert.equal(r.step, 'failed');
  assert.equal(verifyCalled, false, '安装失败后不该再跑 verify');
  const failed = steps.find((s) => s.step === 'failed');
  assert.match(failed.detail.stderr, /404 Not Found/);
});

test('installAgent 安装成功但 verify 拿不到版本号：failed', () => {
  const adapter = {
    ID: 'pi',
    detect: {
      tier: 'cli',
      install: { methods: [{ kind: 'npm', pkg: 'foo' }] },
      verify: { cmd: 'pi --version' },
    },
  };
  const { steps, onProgress } = collectSteps();
  const r = installAgent(adapter, onProgress, {
    platform: 'win32',
    runCmd: () => ({ status: 0 }),
    tryVersionFn: () => '',
  });
  assert.equal(r.ok, false);
  assert.equal(r.step, 'failed');
  assert.deepEqual(steps.map((s) => s.step), ['installing', 'verifying', 'failed']);
});

test('installAgent runCmd 抛异常时也走 failed，不把异常抛给调用方', () => {
  const adapter = {
    ID: 'pi',
    detect: { tier: 'cli', install: { methods: [{ kind: 'npm', pkg: 'foo' }] }, verify: { cmd: 'x' } },
  };
  const { steps, onProgress } = collectSteps();
  const r = installAgent(adapter, onProgress, {
    platform: 'win32',
    runCmd: () => ({ status: -1, error: new Error('spawn failed') }),
    tryVersionFn: () => '1.0.0',
  });
  assert.equal(r.ok, false);
  assert.match(steps.find((s) => s.step === 'failed').detail.stderr, /spawn failed/);
});

test('4 个 cli adapter 的真实 detect 数据都能选出可执行命令（win32）', () => {
  const cliAdapters = [
    require('./adapters/claude'),
    require('./adapters/codex'),
    require('./adapters/pi'),
    require('./adapters/deepseek'),
  ];
  for (const a of cliAdapters) {
    assert.equal(a.detect.tier, 'cli', `${a.ID} 应该是 cli tier`);
    const m = pickMethod(a.detect.install.methods, 'win32');
    assert.ok(m, `${a.ID} 在 win32 上应该能选出一个安装方法`);
    const cmd = methodToCommand(m, 'win32');
    assert.ok(cmd && cmd.length > 0 && !cmd.includes('undefined'), `${a.ID} 应该能拼出非空、不含 undefined 的命令，实际: ${cmd}`);
  }
});

test('workbuddy 的下载页地址是 workbuddy.cn（不是旧的 codebuddy.cn）', () => {
  const workbuddy = require('./adapters/workbuddy');
  const dl = workbuddy.detect.install.methods.find((m) => m.kind === 'download');
  assert.ok(dl, 'workbuddy 应该有一个 download 方式');
  assert.equal(dl.url, 'https://www.workbuddy.cn/work/#download-section');
});

test('workbuddy 的 winget 方式仍然保留（实测 winget 里真实存在 Tencent.WorkBuddy 5.3.14）', () => {
  const workbuddy = require('./adapters/workbuddy');
  const wg = workbuddy.detect.install.methods.find((m) => m.kind === 'winget');
  assert.ok(wg, 'workbuddy 应该保留 winget 方式');
  assert.equal(wg.id, 'Tencent.WorkBuddy');
});

test('pickMethod 对 workbuddy 真实数据在 win32 上选中 winget', () => {
  const workbuddy = require('./adapters/workbuddy');
  const m = pickMethod(workbuddy.detect.install.methods, 'win32');
  assert.ok(m, 'workbuddy 在 win32 上应该能选出方法');
  assert.equal(m.kind, 'winget');
  assert.equal(m.id, 'Tencent.WorkBuddy');
});

test('pickMethod 对 zcode 真实数据在 win32 上选中 winget（zcode.js 本轮不改，锁定现有正确行为）', () => {
  const zcode = require('./adapters/zcode');
  const m = pickMethod(zcode.detect.install.methods, 'win32');
  assert.ok(m, 'zcode 在 win32 上应该能选出方法');
  assert.equal(m.kind, 'winget');
  assert.equal(m.id, 'ZhipuAI.ZCode');
});

test('marvis 现在有一个 download 方式，指向 marvis.qq.com', () => {
  const marvis = require('./adapters/marvis');
  assert.equal(marvis.detect.install.methods.length, 1);
  assert.equal(marvis.detect.install.methods[0].kind, 'download');
  assert.equal(marvis.detect.install.methods[0].url, 'https://marvis.qq.com/');
});

test('marvis 的 warning 文案已更新（不再是"待确认"）', () => {
  const marvis = require('./adapters/marvis');
  assert.equal(marvis.detect.install.warning, '仅支持手动下载安装，暂无命令行安装方式');
});

test('pickMethod 对 marvis 真实数据返回 null（只有 download 方式，没有能静默执行的）', () => {
  const marvis = require('./adapters/marvis');
  const m = pickMethod(marvis.detect.install.methods, 'win32');
  assert.equal(m, null);
});

test('doubao 保持不变：methods 仍为空数组（用户明确排除豆包，不给它做安装引擎）', () => {
  const doubao = require('./adapters/doubao');
  assert.equal((doubao.detect.install.methods || []).length, 0);
});
