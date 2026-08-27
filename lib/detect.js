'use strict';
// Agent 探测引擎：判断某个 AI Agent 是否已安装、装在哪、版本号是多少。
// 只依赖 Node 内置模块，继续保持零 npm 依赖。
// 探测逻辑按 process.platform 选择 adapter 的 win32/darwin/linux 路径；
// Windows 注册表只作为 Windows 的额外来源，macOS/Linux 不会调用 reg.exe。
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

function wildcardRegExp(segment, platform = process.platform) {
  const source = String(segment)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${source}$`, platform === 'win32' ? 'i' : '');
}

// 只枚举路径中包含通配符的目录层级，不使用 shell，避免把未解析的 * 写进配置。
// 当前 adapter 只需要支持“版本目录/*/可执行文件”这一类受控模式。
function probePathPattern(pattern, opts = {}) {
  const existsSync = opts.existsSync || fs.existsSync;
  const readdirSync = opts.readdirSync || fs.readdirSync;
  const statSync = opts.statSync || fs.statSync;
  const separator = path.sep;
  const normalized = String(pattern).replace(/[\\/]+/g, separator);
  const wildcardIndex = normalized.search(/[\*\?]/);
  if (wildcardIndex < 0) return existsSync(normalized) ? normalized : null;

  const separatorIndex = normalized.lastIndexOf(separator, wildcardIndex);
  let base = separatorIndex >= 0 ? normalized.slice(0, separatorIndex) : '.';
  if (!base) base = path.parse(normalized).root || '.';
  const segments = normalized.slice(separatorIndex + 1).split(separator).filter(Boolean);
  let candidates = [base];

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (!/[\*\?]/.test(segment)) {
      candidates = candidates.map((candidate) => path.join(candidate, segment));
      continue;
    }

    const matcher = wildcardRegExp(segment, opts.platform || process.platform);
    const next = [];
    for (const candidate of candidates) {
      let entries;
      try {
        entries = readdirSync(candidate, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!matcher.test(entry.name)) continue;
        if (index < segments.length - 1 && !entry.isDirectory()) continue;
        next.push(path.join(candidate, entry.name));
      }
    }
    candidates = next;
  }

  const existing = candidates.filter((candidate) => existsSync(candidate));
  existing.sort((a, b) => {
    let aTime = 0;
    let bTime = 0;
    try { aTime = Number(statSync(a).mtimeMs || 0); } catch { /* ignore */ }
    try { bTime = Number(statSync(b).mtimeMs || 0); } catch { /* ignore */ }
    if (aTime !== bTime) return bTime - aTime;
    return b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' });
  });
  return existing[0] || null;
}

// 给一批候选路径模板，返回第一个真实存在的（展开后）；支持受控的 * / ? 版本目录。
function probePathList(templates, opts = {}) {
  const existsSync = opts.existsSync || fs.existsSync;
  for (const t of templates || []) {
    const p = expandPath(t, opts);
    const hit = /[\*\?]/.test(p) ? probePathPattern(p, opts) : (existsSync(p) ? p : null);
    if (hit) return hit;
  }
  return null;
}

// EchoBird 的 command_exists/get_command_path 对应实现：不要只猜 npm/bun 的固定目录，
// 还要查当前进程实际继承到的 PATH。Windows 的 where.exe 能同时找到 .exe/.cmd shim。
function defaultFindCommand(command, platform = process.platform) {
  const name = String(command || '').trim();
  if (!name) return null;
  try {
    const lookup = platform === 'win32' ? 'where.exe' : 'which';
    const r = spawnSync(lookup, [name], {
      encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024,
    });
    if (!r || r.error || r.status !== 0) return null;
    return String(r.stdout || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line && !/^INFO:/i.test(line)) || null;
  } catch {
    return null;
  }
}

function findCommand(command, opts = {}) {
  const platform = opts.platform || process.platform;
  if (typeof opts.findCommandFn === 'function') return opts.findCommandFn(command, platform) || null;
  return defaultFindCommand(command, platform);
}

// envVar 既可能直接指向可执行文件，也可能指向一个安装目录；两种写法都兼容。
function probeEnvPath(envVar, command, opts = {}) {
  const env = opts.env || process.env;
  const raw = env && env[envVar];
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const value = expandPath(raw.trim(), opts);
  const candidates = [value];
  const base = path.basename(value).toLowerCase();
  const commandName = String(command || '').toLowerCase();
  if (base !== commandName && !/^.+\.(?:exe|cmd|bat|sh)$/i.test(base)) {
    candidates.push(
      path.join(value, command || ''),
      path.join(value, `${command || ''}.exe`),
      path.join(value, `${command || ''}.cmd`),
    );
  }
  return probePathList(candidates, opts);
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

// 一次 `reg query <hive> /s` 拿到该 hive 下所有子键的卸载信息，
// 避免对每个子键单独 spawn reg.exe（几十上百个子键逐个查会很慢）
function queryUninstallEntries(hive, runReg = defaultRunReg) {
  const r = runReg(['query', hive, '/s']);
  if (!r || r.status !== 0) return [];
  const entries = [];
  let current = null;
  for (const line of String(r.stdout || '').split(/\r?\n/)) {
    if (/^\s*HKEY_/i.test(line)) {
      if (current && current.displayName) entries.push(current);
      current = { key: line.trim() };
      continue;
    }
    const m = line.match(/^\s+(DisplayName|InstallLocation|DisplayIcon|UninstallString|Publisher|DisplayVersion)\s+REG_(?:EXPAND_)?SZ\s+(.*)$/i);
    if (m && current) current[m[1][0].toLowerCase() + m[1].slice(1)] = m[2].trim();
  }
  if (current && current.displayName) entries.push(current);
  return entries;
}

function registryDisplayNameMatches(displayName, displayNamePrefixes = [], opts = {}) {
  const value = String(displayName || '').trim();
  const lower = value.toLowerCase();
  const exactNames = opts.windowsDisplayNames || opts.displayNameNames || [];
  if (exactNames.some((name) => lower === String(name).trim().toLowerCase())) return true;
  return displayNamePrefixes.some((prefix) => {
    const p = String(prefix || '').trim().toLowerCase();
    if (!p || !lower.startsWith(p)) return false;
    // 仅允许单词边界，避免把 OpenCodeX / WorkBuddyHelper 误认成目标程序。
    const next = lower[p.length];
    return !next || !/[a-z0-9]/i.test(next);
  });
}

function registryPublisherMatches(publisher, expected) {
  if (!expected) return true;
  const actual = String(publisher || '').toLowerCase();
  return actual.includes(String(expected).trim().toLowerCase());
}

// 在 Windows 卸载注册表里查找应用（用户级 + 系统级 + 32 位兼容位置都查）。
// 支持 EchoBird 的 exact name / word-boundary prefix / publisher 约束。
function probeRegistryApp(displayNamePrefixes, runReg = defaultRunReg, opts = {}) {
  for (const hive of UNINSTALL_HIVES) {
    let entries;
    if (opts.registryCache && opts.registryCache.has(hive)) {
      entries = opts.registryCache.get(hive);
    } else {
      entries = queryUninstallEntries(hive, runReg);
      if (opts.registryCache) opts.registryCache.set(hive, entries);
    }
    for (const e of entries) {
      if (registryDisplayNameMatches(e.displayName, displayNamePrefixes, opts)
        && registryPublisherMatches(e.publisher, opts.windowsPublisher || opts.publisher)) {
        return { found: true, ...e };
      }
    }
  }
  return { found: false };
}

function cleanRegistryPath(value) {
  let result = String(value || '').trim();
  if (!result) return '';
  if (result.startsWith('"')) {
    const end = result.indexOf('"', 1);
    result = end > 0 ? result.slice(1, end) : result.slice(1);
    result = result.split(',')[0].trim();
  } else {
    result = result.split(',')[0].trim();
  }
  return result;
}

function registryCommandPath(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.startsWith('"')) {
    const end = raw.indexOf('"', 1);
    return end > 0 ? raw.slice(1, end).trim() : raw.slice(1).trim();
  }
  const exe = raw.match(/^(.+?\.exe)(?:\s|$)/i);
  return exe ? exe[1].trim() : cleanRegistryPath(raw).split(/\s+/)[0];
}

function registryExecutablePath(entry, executableNames, opts = {}) {
  if (!entry) return null;
  const existsSync = opts.existsSync || fs.existsSync;
  const readdirSync = opts.readdirSync || fs.readdirSync;
  const names = (executableNames || []).map((name) => String(name));
  const normalizedNames = names.map((name) => name.toLowerCase());
  const candidates = [];
  const roots = [];
  const installLocation = cleanRegistryPath(entry.installLocation);
  if (installLocation) roots.push(installLocation);
  for (const name of names) {
    if (installLocation) candidates.push(path.join(installLocation, name));
  }
  const displayIcon = cleanRegistryPath(entry.displayIcon);
  if (displayIcon) {
    if (!names.length || normalizedNames.includes(path.basename(displayIcon).toLowerCase())) {
      candidates.push(displayIcon);
    }
    // 安装器经常把 DisplayIcon 指向卸载程序或 .ico，而不是主程序；
    // 仍然把它所在目录作为受控扫描根，避免“注册表已命中但 executablePath 为空”。
    roots.push(path.dirname(displayIcon));
  }
  const uninstallPath = registryCommandPath(entry.uninstallString);
  if (uninstallPath) roots.push(path.dirname(uninstallPath));
  for (const candidate of candidates) {
    const expanded = expandPath(candidate, opts);
    if (existsSync(expanded)) return expanded;
  }

  // 只在注册表已经确认安装的目录内做有限深度扫描，不扫描整个磁盘。
  // 兼容 Electron 安装器的 resources\app\ZCode.exe、app-*\ZCode.exe 等布局。
  const wanted = new Set(normalizedNames);
  const prefixes = (opts.executablePrefixes || []).map((name) => String(name).toLowerCase());
  const maxDepth = Number.isFinite(Number(opts.registrySearchDepth))
    ? Math.max(0, Math.min(4, Number(opts.registrySearchDepth)))
    : 3;
  const visited = new Set();
  for (const rawRoot of roots) {
    const root = expandPath(rawRoot, opts);
    if (!root || visited.has(root.toLowerCase())) continue;
    visited.add(root.toLowerCase());
    const queue = [{ dir: root, depth: 0 }];
    while (queue.length) {
      const current = queue.shift();
      let entries;
      try { entries = readdirSync(current.dir, { withFileTypes: true }); } catch { continue; }
      for (const entryItem of entries) {
        const full = path.join(current.dir, entryItem.name);
        const lowerName = String(entryItem.name).toLowerCase();
        const stem = lowerName.replace(/\.exe$/i, '');
        const isPrefixedMatch = prefixes.some((prefix) => stem === prefix || stem.startsWith(`${prefix} `) || stem.startsWith(`${prefix}-`));
        if (entryItem.isFile && entryItem.isFile() && (wanted.has(lowerName) || isPrefixedMatch)) {
          return full;
        }
        if (current.depth >= maxDepth || !entryItem.isDirectory || !entryItem.isDirectory()) continue;
        queue.push({ dir: full, depth: current.depth + 1 });
      }
    }
  }
  return null;
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
      if (typeof v === 'string' || Array.isArray(v)) {
        // 旧版 string/array 只表示 CLI 路径；读取时升级为双变体结构。
        out[id] = { cli: normalizeOverridePaths(v), desktop: [] };
      } else if (v && typeof v === 'object') {
        out[id] = {
          cli: normalizeOverridePaths(v.cli),
          desktop: normalizeOverridePaths(v.desktop),
        };
      }
    }
    return out;
  } catch {
    return {};
  }
}

function normalizeOverridePaths(value) {
  const list = typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];
  return list.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim());
}

function getOverridePaths(overrides, agent, kind = 'cli') {
  const value = overrides && overrides[agent];
  if (Array.isArray(value) || typeof value === 'string') return kind === 'cli' ? normalizeOverridePaths(value) : [];
  return value && typeof value === 'object' ? normalizeOverridePaths(value[kind]) : [];
}

function saveOverrideVariant(agent, executablePath, kind = 'cli', filePath = USER_OVERRIDES_PATH) {
  if (!['cli', 'desktop'].includes(kind)) throw new TypeError('路径变体必须是 cli 或 desktop');
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const current = loadUserOverrides(filePath);
  const entry = current[agent] || { cli: [], desktop: [] };
  entry[kind] = normalizeOverridePaths(executablePath);
  if (entry.cli.length || entry.desktop.length) current[agent] = entry;
  else delete current[agent];
  fs.writeFileSync(filePath, JSON.stringify(current, null, 2));
  return current;
}

function saveUserOverride(agent, executablePath, filePath = USER_OVERRIDES_PATH) {
  return saveOverrideVariant(agent, executablePath, 'cli', filePath);
}

function saveDesktopUserOverride(agent, executablePath, filePath = USER_OVERRIDES_PATH) {
  return saveOverrideVariant(agent, executablePath, 'desktop', filePath);
}

// 把 verify.cmd 的参数拆成 argv。adapter 里的版本命令都是简单的 CLI 参数，
// 这里仍保留引号处理，避免带空格的参数被错误拆开。
function parseCommandLineArgs(value) {
  const args = [];
  let current = '';
  let quoted = false;
  for (const ch of String(value || '')) {
    if (ch === '"') {
      quoted = !quoted;
      continue;
    }
    if (/\s/.test(ch) && !quoted) {
      if (current) {
        args.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (current) args.push(current);
  return args;
}

function resolveVerifyInvocation(cmd, executablePath) {
  const original = String(cmd || '').trim();
  if (!original || !executablePath) return null;
  const match = original.match(/^(?:"([^"]+)"|(\S+))(.*)$/);
  if (!match) return null;
  const commandToken = match[1] || match[2];
  const stripExt = (value) => path.basename(value).replace(/\.(?:cmd|bat|exe)$/i, '').toLowerCase();
  if (stripExt(commandToken) !== stripExt(executablePath)) return null;
  return {
    executablePath,
    extension: path.extname(executablePath).toLowerCase(),
    args: parseCommandLineArgs(match[3] || ''),
  };
}

function tryVersion(cmd, executablePath = '', opts = {}) {
  if (!cmd) return '';
  const platform = opts.platform || process.platform;
  try {
    const invocation = resolveVerifyInvocation(cmd, executablePath);
    const isShim = invocation && ['.cmd', '.bat', '.sh'].includes(invocation.extension);
    const r = invocation && !isShim
      ? spawnSync(invocation.executablePath, invocation.args, {
        encoding: 'utf8', windowsHide: true, timeout: 8000,
      })
      : invocation && isShim && platform === 'win32'
        ? spawnSync('cmd.exe', [
          '/d', '/s', '/c', 'call', invocation.executablePath, ...invocation.args,
        ], { encoding: 'utf8', windowsHide: true, timeout: 8000 })
        : spawnSync(platform === 'win32' ? 'cmd.exe' : (process.env.SHELL || '/bin/sh'),
          platform === 'win32' ? ['/d', '/c', String(cmd)] : ['-lc', String(cmd)],
          { encoding: 'utf8', windowsHide: true, timeout: 8000 });
    if (r.error || r.status !== 0) return '';
    return String(r.stdout || r.stderr || '').split('\n')[0].trim();
  } catch {
    return '';
  }
}

function msixPackageIdentityMatches(packageName, packageToken) {
  const expected = String(packageToken || '').split('_')[0].toLowerCase();
  const actual = String(packageName || '').split('_')[0].toLowerCase();
  if (!expected || !actual) return false;
  // Windows Store 的 package family 后缀可能变化，Beta 频道也可能多一段标记；
  // 比较包名身份而不是写死完整目录名。
  return actual === expected || actual.startsWith(`${expected}.beta`) || expected.startsWith(`${actual}.beta`);
}

function probeWindowsMsix(launchUri, opts = {}) {
  const platform = opts.platform || process.platform;
  if (platform !== 'win32' || !launchUri) return null;
  const match = String(launchUri).match(/AppsFolder[\\/]([^!\\/]+)!/i);
  if (!match) return null;
  const localAppData = expandPath('%LOCALAPPDATA%', opts);
  if (!localAppData || localAppData.includes('%LOCALAPPDATA%')) return null;
  const packagesDir = path.join(localAppData, 'Packages');
  const readdirSync = opts.readdirSync || fs.readdirSync;
  try {
    const entries = readdirSync(packagesDir, { withFileTypes: true });
    const hit = entries.find((entry) => entry.isDirectory && entry.isDirectory()
      && msixPackageIdentityMatches(entry.name, match[1]));
    return hit ? path.join(packagesDir, hit.name) : null;
  } catch {
    return null;
  }
}

function probeConfigDirectory(def, opts = {}) {
  if (!def.detectByConfigDir) return null;
  const dirs = [def.configDir, ...(def.configDirAlt ? [def.configDirAlt] : [])]
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .filter(Boolean);
  return probePathList(dirs, opts);
}

// 探测单个变体。CLI 与 Desktop 必须分开探测，不能把桌面 exe 当作 CLI override。
function probeDefinition(id, def, opts = {}, allowOverrides = true) {
  if (!def) return { id, installed: false, tier: 'unknown', reason: 'no detect config' };

  const platform = opts.platform || process.platform;
  const overrides = opts.userOverrides || loadUserOverrides();
  const runReg = opts.runReg || defaultRunReg;
  const verifyFn = opts.tryVersionFn || tryVersion;
  const verifyCmd = def.verify && def.verify.cmd;
  const probe = def.probe || {};
  const command = probe.command || def.command || '';
  const envVar = probe.envVar || def.envVar || '';

  // 1. 用户自定义路径覆盖优先于内置探测
  const overrideKind = def.tier === 'gui' ? 'desktop' : 'cli';
  const overridePaths = allowOverrides ? getOverridePaths(overrides, id, overrideKind) : null;
  if (overridePaths && overridePaths.length) {
    const hit = probePathList(overridePaths, opts);
    if (hit) {
      return {
        id,
        tier: def.tier,
        installed: true,
        path: hit,
        executablePath: def.probe && def.probe.executable ? hit : null,
        source: 'override',
        version: verifyFn(verifyCmd, hit, { platform }),
      };
    }
  }

  // 2. 内置路径列表：只使用当前平台的候选，避免把另一台电脑的 Windows 路径带到 macOS。
  const envHit = envVar ? probeEnvPath(envVar, command, opts) : null;
  const commandHit = command ? findCommand(command, opts) : null;
  // 保留 def.probe[platform] 这一显式分支，便于跨平台静态检查和旧版测试识别路径选择。
  const platformPaths = (def.probe && def.probe[platform]) || probe[platform] || [];
  const pathHit = probePathList(platformPaths, opts);

  // Store/MSIX 应用可能没有可读的固定 exe，但仍然可以从 AppsFolder 包身份确认安装。
  const msixHit = probeWindowsMsix(probe.launchUri || def.launchUri, opts);

  // 3. registry 探测：EchoBird 的 installHints 可以附着在普通路径定义上，
  // 因此只要求有明确 hints，不再强制 kind:'registry'。
  let regHit = null;
  if (platform === 'win32' && probe.registryHints) {
    const hints = probe.registryHints;
    const prefixes = hints.displayNamePrefixes || hints.windowsDisplayNamePrefixes || [];
    const exactNames = hints.windowsDisplayNames || [];
    if (prefixes.length || exactNames.length) {
      const r = probeRegistryApp(prefixes, runReg, { ...hints, registryCache: opts.registryCache });
      if (r.found) regHit = r;
    }
  }

  const registryPath = registryExecutablePath(
    regHit,
    probe.executableNames,
    opts,
  );

  // 已知的用户/平台路径比 PATH 更精确；PATH 只作为跨机器安装位置未知时的兜底。
  const executablePath = registryPath || envHit || (probe.executable ? pathHit : null) || commandHit;
  if (envHit || pathHit || commandHit || registryPath || regHit || msixHit) {
    const source = envHit ? 'env'
      : pathHit ? 'builtin'
        : commandHit ? 'command'
          : (registryPath || regHit) ? 'registry'
            : 'msix';
    return {
      id, tier: def.tier, installed: true,
      path: executablePath || msixHit || null,
      executablePath,
      registryName: regHit ? regHit.displayName : null,
      source,
      version: verifyFn(verifyCmd, executablePath, { platform }),
    };
  }

  // 配置目录是弱信号：只有定义显式声明，且命令/固定路径/注册表/MSIX 都没有命中时才采用，
  // 避免残留配置目录把已卸载的程序误报为“已安装”。
  const configPath = probeConfigDirectory(def, opts);
  if (configPath) {
    return {
      id, tier: def.tier, installed: true, path: configPath,
      executablePath: null, source: 'config', version: '',
    };
  }

  return { id, tier: def.tier, installed: false };
}

// 探测单个 agent：adapter 必须有 ID 和 detect 两个字段（detect 结构见 lib/adapters/*.js）。
// detect.desktopProbe 是可选的 GUI 变体定义；发现 Desktop 时保留 CLI 主探测结果，
// 同时返回 desktopExecutablePath，供“自动配置路径”和启动恢复使用。
function probeAgent(adapter, opts = {}) {
  const id = adapter.ID;
  const primary = probeDefinition(id, adapter.detect, opts, true);
  const desktop = adapter.detect && adapter.detect.desktopProbe
    ? probeDefinition(id, {
      tier: 'gui',
      ...adapter.detect.desktopProbe,
      probe: adapter.detect.desktopProbe.probe,
      }, { ...opts, userOverrides: opts.userOverrides || loadUserOverrides() }, true)
    : null;
  if (!desktop) return primary;
  const desktopInstalled = desktop.installed === true;
  const cliInstalled = primary.installed === true && primary.tier === 'cli';
  return {
    ...primary,
    installed: primary.installed === true || desktopInstalled,
    cliInstalled,
    desktopInstalled,
    desktopPath: desktop.path || null,
    desktopExecutablePath: desktop.executablePath || null,
    desktopSource: desktop.source || null,
    desktopVersion: desktop.version || null,
    variant: cliInstalled && desktopInstalled ? 'cli+desktop' : desktopInstalled ? 'desktop' : (primary.installed ? 'cli' : null),
  };
}

// 依次探测一批 adapter，返回按 ID 建的 map。probeAgent 内部是同步 spawnSync，这里包一层
// async 只是为了配合 server.js 路由的 await 写法，8 个 agent 量级下顺序执行完全够用。
async function probeAll(adapters, opts = {}) {
  const overrides = opts.userOverrides || loadUserOverrides();
  const registryCache = opts.registryCache || new Map();
  const out = {};
  for (const a of adapters) {
    if (!a.detect) continue;
    out[a.ID] = probeAgent(a, { ...opts, userOverrides: overrides, registryCache });
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

// 执行一条安装命令。Windows 走 cmd.exe；macOS/Linux 走当前用户 shell。
// 超时给 10 分钟：装 CLI 工具走 npm 拉包可能很慢，8 秒的 tryVersion 超时在这里完全不够。
function defaultRunCmd(cmd) {
  try {
    const platform = process.platform;
    return spawnSync(platform === 'win32' ? 'cmd.exe' : (process.env.SHELL || '/bin/sh'),
      platform === 'win32' ? ['/c', cmd] : ['-lc', cmd], {
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
  const version = verifyFn(def.verify && def.verify.cmd, '', { platform });
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
  expandPath, probePathList, findCommand, probeWindowsMsix, queryUninstallEntries, probeRegistryApp,
  loadUserOverrides, saveUserOverride, saveDesktopUserOverride, saveOverrideVariant, getOverridePaths,
  registryExecutablePath, tryVersion, probeDefinition, probeAgent, probeAll,
  pickMethod, satisfiesNodeVersion, methodToCommand, installAgent,
  USER_OVERRIDES_PATH,
};
