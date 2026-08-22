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
    const m = line.match(/^\s+DisplayName\s+REG_SZ\s+(.+)$/);
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

module.exports = {
  expandPath, probePathList, queryUninstallEntries, probeRegistryApp,
  USER_OVERRIDES_PATH,
};
