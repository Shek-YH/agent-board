'use strict';
// Agent 探测引擎：判断某个 AI Agent 是否已安装、装在哪、版本号是多少。
// 只依赖 Node 内置模块，继续保持零 npm 依赖。
// 这轮只实现 Windows（win32）探测逻辑；probe.darwin/probe.linux 数据已经带上，留给以后跨平台用。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const USER_OVERRIDES_PATH = path.join(os.homedir(), '.agent-board', 'tool-paths.json');

// 展开路径模板里的 %ENV_VAR% 和开头的 ~
function expandPath(template, opts = {}) {
  const env = opts.env || process.env;
  const home = opts.home || os.homedir();
  let s = String(template).replace(/%([^%]+)%/g, (m, name) => {
    const v = env[name];
    return v != null ? v : m;
  });
  if (s === '~') s = home;
  else if (s.startsWith('~\\') || s.startsWith('~/')) s = path.join(home, s.slice(2));
  return s;
}

// 给一批候选路径模板，返回第一个真实存在的（展开后）；都不存在返回 null
function probePathList(templates, opts = {}) {
  for (const t of templates || []) {
    const p = expandPath(t, opts);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function defaultRunReg(args) {
  try {
    return spawnSync('reg', args, { encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 8 * 1024 * 1024 });
  } catch {
    return null;
  }
}

const UNINSTALL_HIVES = [
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
];

// 一次 `reg query <hive> /s /v DisplayName` 拿到该 hive 下所有子键的 DisplayName，
// 避免对每个子键单独 spawn reg.exe（几十上百个子键逐个查会很慢）
function queryUninstallEntries(hive, runReg = defaultRunReg) {
  const r = runReg(['query', hive, '/s', '/v', 'DisplayName']);
  if (!r || r.status !== 0) return [];
  const entries = [];
  let currentKey = '';
  for (const line of String(r.stdout || '').split(/\r?\n/)) {
    if (line.startsWith('HKEY_')) { currentKey = line.trim(); continue; }
    const m = line.match(/^\s+DisplayName\s+REG_(?:EXPAND_)?SZ\s+(.+)$/);
    if (m && currentKey) entries.push({ key: currentKey, displayName: m[1].trim() });
  }
  return entries;
}

// 在 Windows 卸载注册表里查找 DisplayName 以给定前缀开头的应用（用户级 + 系统级 + 32 位兼容位置都查）
function probeRegistryApp(displayNamePrefixes, runReg = defaultRunReg) {
  for (const hive of UNINSTALL_HIVES) {
    for (const e of queryUninstallEntries(hive, runReg)) {
      if ((displayNamePrefixes || []).some((p) => e.displayName.startsWith(p))) {
        return { found: true, displayName: e.displayName, key: e.key };
      }
    }
  }
  return { found: false };
}

// 读用户自定义路径覆盖：~/.agent-board/tool-paths.json。容错——文件不存在/JSON 解析失败/
// 字段类型不对，一律降级成空对象，绝不能让探测流程崩溃
function loadUserOverrides(filePath = USER_OVERRIDES_PATH) {
  try {
    if (!fs.existsSync(filePath)) return {};
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out = {};
    for (const [id, v] of Object.entries(raw)) {
      if (typeof v === 'string') out[id] = [v];
      else if (Array.isArray(v)) out[id] = v.filter((x) => typeof x === 'string');
    }
    return out;
  } catch {
    return {};
  }
}

// 装了之后想拿版本号：跑 verify.cmd（如 "pi --version"），取第一行输出。
// 走 cmd.exe /c 而不是直接 spawnSync(bin, args)：npm 全局安装的 CLI 在 Windows 上很多是
// .cmd shim，直接 spawn 不经过 cmd.exe 解释会找不到（跟 server.js 里 launchOrFocus 的做法一致）。
function tryVersion(cmd) {
  if (!cmd) return '';
  try {
    const r = spawnSync('cmd.exe', ['/c', cmd], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
    if (r.error || r.status !== 0) return '';
    return String(r.stdout || r.stderr || '').split('\n')[0].trim();
  } catch {
    return '';
  }
}

// 探测单个 agent：adapter 必须有 ID 和 detect 两个字段（detect 结构见 lib/adapters/*.js）
function probeAgent(adapter, opts = {}) {
  const def = adapter.detect;
  const id = adapter.ID;
  if (!def) return { id, installed: false, tier: 'unknown', reason: 'no detect config' };

  const overrides = opts.userOverrides || loadUserOverrides();
  const runReg = opts.runReg || defaultRunReg;
  const verifyCmd = def.verify && def.verify.cmd;

  // 1. 用户自定义路径覆盖优先于内置探测
  const overridePaths = overrides[id];
  if (overridePaths && overridePaths.length) {
    const hit = probePathList(overridePaths, opts);
    if (hit) {
      return { id, tier: def.tier, installed: true, path: hit, source: 'override', version: tryVersion(verifyCmd) };
    }
  }

  // 2. 内置路径列表（这轮只实现 win32）
  const platformPaths = (def.probe && def.probe.win32) || [];
  const pathHit = probePathList(platformPaths, opts);

  // 3. registry 探测（只有 kind:'registry' 且带 registryHints 才做）
  let regHit = null;
  if (def.probe && def.probe.kind === 'registry' && def.probe.registryHints) {
    const prefixes = def.probe.registryHints.displayNamePrefixes || [];
    if (prefixes.length) {
      const r = probeRegistryApp(prefixes, runReg);
      if (r.found) regHit = r;
    }
  }

  if (pathHit || regHit) {
    return {
      id, tier: def.tier, installed: true,
      path: pathHit || null,
      registryName: regHit ? regHit.displayName : null,
      source: 'builtin',
      version: tryVersion(verifyCmd),
    };
  }

  return { id, tier: def.tier, installed: false };
}

// 依次探测一批 adapter，返回按 ID 建的 map。probeAgent 内部是同步 spawnSync，这里包一层
// async 只是为了配合 server.js 路由的 await 写法，8 个 agent 量级下顺序执行完全够用。
async function probeAll(adapters, opts = {}) {
  const overrides = opts.userOverrides || loadUserOverrides();
  const out = {};
  for (const a of adapters) {
    if (!a.detect) continue;
    out[a.ID] = probeAgent(a, { ...opts, userOverrides: overrides });
    await new Promise((resolve) => setImmediate(resolve)); // 让出事件循环，避免连续多个 spawnSync 把整个单线程 server 卡死一整段
  }
  return out;
}

// 从 install.methods 里选唯一一个当前平台可用的方法。
// 刻意不做「这个失败自动试下一个」的降级链：四选一的自动降级会让「这次到底跑了哪条命令」
// 变得不确定，出问题不好复现。失败就如实报错，让用户自己决定重试还是换方式。
// 优先级：平台专属安装器脚本 > winget（仅 win32）> npm（跨平台兜底）——按优先级分轮扫描，
// 不按数组书写顺序决定（adapter 数据里的顺序有的是 npm 在前，不能靠数组顺序当优先级）
function pickMethod(methods, platform = process.platform) {
  const list = methods || [];
  for (const m of list) {
    if (m.kind === 'script') {
      if (platform === 'win32' && m.win32) return m;
      if (platform !== 'win32' && m.posix) return m;
    }
  }
  if (platform === 'win32') {
    const wg = list.find((m) => m.kind === 'winget');
    if (wg) return wg;
  }
  return list.find((m) => m.kind === 'npm') || null;
}

module.exports = {
  expandPath, probePathList, queryUninstallEntries, probeRegistryApp,
  loadUserOverrides, tryVersion, probeAgent, probeAll, pickMethod,
  USER_OVERRIDES_PATH,
};
