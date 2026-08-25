'use strict';
// Agent 探测引擎：判断某个 AI Agent 是否已安装、装在哪、版本号是多少。
// 只依赖 Node 内置模块，继续保持零 npm 依赖。
// 这轮只实现 Windows（win32）探测逻辑；probe.darwin/probe.linux 数据已经带上，留给以后跨平台用。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { getConfigDir } = require('./runtime-paths');

const USER_OVERRIDES_PATH = path.join(getConfigDir(), 'tool-paths.json');

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

// 比较 Node 版本是否满足 ">=X" / ">=X.Y" / ">=X.Y.Z" 形式的要求。
// 只支持 ">=" 这一种写法——现有 4 个 cli adapter 的 requirements.node 全是这个形式，
// 不引入完整的 semver 解析（那会是这个零依赖项目里第一个真正需要外部库的地方）。
function satisfiesNodeVersion(current, requirement) {
  if (!requirement) return true;
  const m = String(requirement).match(/^>=\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!m) return true;                       // 看不懂的写法一律放行，不因为解析不了就挡住用户
  const need = [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)];
  const cm = String(current).match(/v?(\d+)\.(\d+)\.(\d+)/);
  if (!cm) return true;
  const have = [Number(cm[1]), Number(cm[2]), Number(cm[3])];
  for (let i = 0; i < 3; i++) {
    if (have[i] > need[i]) return true;
    if (have[i] < need[i]) return false;
  }
  return true;                               // 完全相等也算满足
}

// 执行一条安装命令。和 tryVersion 一样走 cmd.exe /c（Windows 上 npm 全局装的是 .cmd shim）。
// 超时给 10 分钟：装 CLI 工具走 npm 拉包可能很慢，8 秒的 tryVersion 超时在这里完全不够。
function defaultRunCmd(cmd) {
  try {
    return spawnSync('cmd.exe', ['/c', cmd], {
      encoding: 'utf8', windowsHide: true, timeout: 10 * 60 * 1000, maxBuffer: 16 * 1024 * 1024,
    });
  } catch (e) {
    return { status: -1, error: e };
  }
}

// 把一个 method 描述翻译成真正要跑的命令字符串
function methodToCommand(method, platform = process.platform) {
  if (method.kind === 'script') return platform === 'win32' ? method.win32 : method.posix;
  if (method.kind === 'npm') {
    const flags = (method.flags || []).join(' ');
    return `npm install -g ${flags ? flags + ' ' : ''}${method.pkg}`.replace(/\s+/g, ' ').trim();
  }
  if (method.kind === 'winget') {
    const flags = (method.flags || []).join(' ');
    return `winget install --id ${method.id}${flags ? ' ' + flags : ''}`;
  }
  return null;
}

// 安装一个 tier:'cli' 的 agent。同步执行（内部 spawnSync），通过 onProgress(step, detail) 汇报进度。
// opts 全部可注入，测试时不碰真实系统：runCmd / tryVersionFn / nodeVersion / platform。
function installAgent(adapter, onProgress = () => {}, opts = {}) {
  const def = adapter.detect || {};
  const platform = opts.platform || process.platform;
  const runCmd = opts.runCmd || defaultRunCmd;
  const verifyFn = opts.tryVersionFn || tryVersion;
  const nodeVersion = opts.nodeVersion || process.version;

  // ① 被墙拦截：不做真实地区探测，固定按「中国大陆网络环境」判断（见设计文档）
  const blocked = def.network && def.network.blockedRegions && def.network.blockedRegions['zh-CN'];
  if (blocked) {
    onProgress('blocked', { message: blocked });
    return { ok: false, step: 'blocked' };
  }

  // ② 前置依赖（目前只有 Node 版本这一种）
  const needNode = def.requirements && def.requirements.node;
  if (needNode && !satisfiesNodeVersion(nodeVersion, needNode)) {
    onProgress('deps-missing', { need: needNode, have: nodeVersion });
    return { ok: false, step: 'deps-missing' };
  }

  // ③ 选方法
  const method = pickMethod(def.install && def.install.methods, platform);
  const command = method && methodToCommand(method, platform);
  if (!command) {
    onProgress('no-method', { platform });
    return { ok: false, step: 'no-method' };
  }

  // ④ 执行
  onProgress('installing', { command, method: method.kind });
  const r = runCmd(command);
  if (!r || r.error || r.status !== 0) {
    const stderr = r && (r.stderr || (r.error && r.error.message)) || '';
    onProgress('failed', { command, stderr: String(stderr).slice(0, 2000) });
    return { ok: false, step: 'failed' };
  }

  // ⑤ 校验
  onProgress('verifying', {});
  const version = verifyFn(def.verify && def.verify.cmd);
  if (!version) {
    onProgress('failed', { reason: '安装命令执行成功，但 verify 拿不到版本号（可能装上了但当前进程的 PATH 还没刷新，重启 agent-board 再看看）' });
    return { ok: false, step: 'failed' };
  }

  // ⑥ 完成
  const tellUser = (def.afterInstall && def.afterInstall.tellUser) || [];
  onProgress('done', { version, tellUser });
  return { ok: true, step: 'done', version };
}

module.exports = {
  expandPath, probePathList, queryUninstallEntries, probeRegistryApp,
  loadUserOverrides, tryVersion, probeAgent, probeAll,
  pickMethod, satisfiesNodeVersion, methodToCommand, installAgent,
  USER_OVERRIDES_PATH,
};
