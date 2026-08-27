'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLAUDE_PACKAGE_PATTERN = 'Claude_*_x64__pzs8sxrjxfjjc';
const PACKAGE_ROOT_KEY = 'HKCU\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\CurrentVersion\\AppModel\\Repository\\Packages';
const APPX_APPLICATIONS_KEY = 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Appx\\AppxAllUserStore\\Applications';

function defaultRunReg(args) {
  try {
    return spawnSync('reg.exe', args, {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
  } catch {
    return null;
  }
}

function parseRegistryKeys(stdout) {
  return String(stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^HKEY_/i.test(line));
}

function parseRegistryValue(stdout, name) {
  const escaped = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(stdout || '').match(new RegExp(`^\\s*${escaped}\\s+REG_[A-Z_]+\\s+(.+?)\\s*$`, 'im'));
  return match ? match[1].trim() : '';
}

function packageRootsFromRegistry(runReg = defaultRunReg) {
  const roots = [];
  const sources = [
    { hive: PACKAGE_ROOT_KEY, value: 'PackageRootFolder' },
    { hive: APPX_APPLICATIONS_KEY, value: 'Path' },
  ];

  for (const source of sources) {
    let keyResult;
    try {
      keyResult = runReg(['query', source.hive, '/f', CLAUDE_PACKAGE_PATTERN, '/k']);
    } catch {
      continue;
    }
    if (!keyResult || keyResult.status !== 0) continue;

    for (const key of parseRegistryKeys(keyResult.stdout)) {
      let valueResult;
      try {
        valueResult = runReg(['query', key, '/v', source.value]);
      } catch {
        continue;
      }
      if (!valueResult || valueResult.status !== 0) continue;
      let root = parseRegistryValue(valueResult.stdout, source.value);
      if (source.value === 'Path' && /\\AppxManifest\.xml$/i.test(root)) root = path.win32.dirname(root);
      if (root) roots.push(root);
    }
    if (roots.length) break;
  }

  return [...new Set(roots)];
}

function resolveClaudeDesktopExe({
  env = process.env,
  homedir = os.homedir(),
  platform = process.platform,
  existsSync = fs.existsSync,
  runReg = defaultRunReg,
} = {}) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const candidates = [env.CLAUDE_DESKTOP_EXE];

  if (platform === 'darwin') {
    candidates.push(
      '/Applications/Claude.app/Contents/MacOS/Claude',
      pathApi.join(homedir, 'Applications', 'Claude.app', 'Contents', 'MacOS', 'Claude'),
    );
  } else if (platform === 'win32') {
    const programFiles = env.PROGRAMFILES || 'C:\\Program Files';
    // 当前机器已验证的 Claude MSIX 路径。版本变化时由下面的注册表探测接管。
    candidates.push(path.win32.join(
      programFiles,
      'WindowsApps',
      'Claude_1.37937.1.0_x64__pzs8sxrjxfjjc',
      'app',
      'claude.exe',
    ));
    candidates.push(
      path.win32.join(homedir, 'AppData', 'Local', 'AnthropicClaude', 'claude.exe'),
      path.win32.join(homedir, 'AppData', 'Local', 'Programs', 'Claude', 'Claude.exe'),
      path.win32.join(homedir, 'AppData', 'Local', 'Claude', 'Claude.exe'),
    );
  }

  const directHit = candidates.filter(Boolean).find((file) => existsSync(file));
  if (directHit) return directHit;

  if (platform === 'win32') {
    const registryCandidates = packageRootsFromRegistry(runReg)
      .map((root) => path.win32.join(root, 'app', 'claude.exe'));
    const registryHit = registryCandidates.find((file) => existsSync(file));
    if (registryHit) return registryHit;
  }

  return '';
}

module.exports = {
  CLAUDE_PACKAGE_PATTERN,
  packageRootsFromRegistry,
  resolveClaudeDesktopExe,
};
