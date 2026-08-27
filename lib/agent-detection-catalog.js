'use strict';

// EchoBird tools/*/paths.json 的 Agent 子集。
// 这些条目只参与“应用管理”的安装探测，不参与会话扫描；以后补齐数据源 adapter
// 时，可把对应条目迁移到 lib/adapters/<id>.js，避免重复维护探测路径。

function identity(name, description, notToConfuseWith = []) {
  return { description: description || `${name} AI Agent`, notToConfuseWith };
}

function install(url) {
  return {
    methods: [{ kind: 'download', url }],
    warning: '请在官方页面完成安装；Agent Board 不会执行第三方安装命令',
  };
}

function cli({ id, name, command, envVar, win32, darwin, linux, configDir, detectByConfigDir = false, url, color }) {
  return {
    ID: id,
    probeOnly: true,
    meta: { name, color },
    detect: {
      tier: 'cli',
      identityGuard: identity(name),
      requirements: {},
      probe: {
        kind: 'path',
        executable: true,
        command,
        ...(envVar ? { envVar } : {}),
        win32,
        darwin,
        linux,
      },
      ...(configDir ? { configDir, detectByConfigDir } : {}),
      install: install(url),
    },
  };
}

function gui({ id, name, win32, darwin, linux, command, envVar, launchUri, registryHints, url, color }) {
  return {
    ID: id,
    probeOnly: true,
    meta: { name, color },
    detect: {
      tier: 'gui',
      identityGuard: identity(name),
      requirements: {},
      probe: {
        kind: 'path',
        executable: true,
        ...(command ? { command } : {}),
        ...(envVar ? { envVar } : {}),
        ...(launchUri ? { launchUri } : {}),
        ...(registryHints ? { registryHints } : {}),
        win32,
        darwin,
        linux,
      },
      install: install(url),
    },
  };
}

const DETECTION_CATALOG = [
  cli({
    id: 'aider', name: 'Aider', command: 'aider', color: '#7C3AED',
    win32: [
      '%USERPROFILE%\\.local\\bin\\aider.exe',
      '%APPDATA%\\Python\\Scripts\\aider.exe',
      '%LOCALAPPDATA%\\Programs\\Python\\Python312\\Scripts\\aider.exe',
      '%LOCALAPPDATA%\\Programs\\Python\\Python311\\Scripts\\aider.exe',
      '%LOCALAPPDATA%\\Programs\\Python\\Python310\\Scripts\\aider.exe',
    ],
    darwin: ['/usr/local/bin/aider', '/opt/homebrew/bin/aider', '~/.local/bin/aider'],
    linux: ['/usr/local/bin/aider', '/usr/bin/aider', '~/.local/bin/aider'],
    url: 'https://aider.chat/docs/install.html',
  }),
  cli({
    id: 'claudescience', name: 'Claude Science', command: '', color: '#D97757',
    win32: [],
    darwin: ['/Applications/Claude Science.app/Contents/MacOS/Claude Science'],
    linux: ['~/.local/bin/claude-science', '/usr/local/bin/claude-science', '/usr/bin/claude-science'],
    url: 'https://claude.com/product/claude-science',
  }),
  cli({
    id: 'coffeecli', name: 'Coffee CLI', command: 'coffee-cli', color: '#A16207',
    win32: ['%LOCALAPPDATA%\\Coffee CLI\\coffee-cli.exe'],
    darwin: ['/Applications/Coffee CLI.app/Contents/MacOS/Coffee CLI', '/Applications/Coffee CLI.app/Contents/MacOS/coffee-cli'],
    linux: ['/opt/Coffee CLI/coffee-cli', '/opt/coffee-cli/coffee-cli', '/usr/bin/coffee-cli', '/usr/local/bin/coffee-cli', '~/.local/bin/coffee-cli'],
    configDir: '~/.coffee-cli', url: 'https://coffeecli.com/',
  }),
  gui({
    id: 'cursor', name: 'Cursor', color: '#38BDF8',
    win32: ['%LOCALAPPDATA%\\Programs\\cursor\\Cursor.exe'],
    darwin: ['/Applications/Cursor.app/Contents/MacOS/Cursor'],
    linux: ['/usr/bin/cursor', '/opt/Cursor/cursor'],
    registryHints: { windowsDisplayNames: ['Cursor'], windowsPublisher: 'Anysphere' },
    url: 'https://cursor.com/',
  }),
  gui({
    id: 'geminidesktop', name: 'Gemini 桌面端', color: '#4285F4',
    win32: [],
    darwin: ['/Applications/Gemini.app/Contents/MacOS/Gemini'],
    linux: [],
    registryHints: { windowsDisplayNames: ['Gemini'], windowsPublisher: 'Google' },
    url: 'https://gemini.google/mac/',
  }),
  cli({
    id: 'grok', name: 'Grok Build', command: 'grok', envVar: 'GROK_PATH', color: '#111827',
    win32: [
      '%USERPROFILE%\\.grok\\bin\\grok.exe', '%USERPROFILE%\\.local\\bin\\grok.exe',
      '%LOCALAPPDATA%\\Programs\\grok\\grok.exe', '%USERPROFILE%\\.bun\\bin\\grok.exe', '%LOCALAPPDATA%\\pnpm\\grok.exe',
    ],
    darwin: ['~/.grok/bin/grok', '/usr/local/bin/grok', '/opt/homebrew/bin/grok', '~/.local/bin/grok', '~/.bun/bin/grok', '~/.npm-global/bin/grok', '~/Library/pnpm/grok'],
    linux: ['~/.grok/bin/grok', '/usr/local/bin/grok', '/usr/bin/grok', '~/.local/bin/grok', '~/.bun/bin/grok', '~/.npm-global/bin/grok', '~/.local/share/pnpm/grok'],
    configDir: '~/.grok', url: 'https://docs.x.ai/build/overview',
  }),
  cli({
    id: 'kilo', name: 'Kilo Code', command: 'kilo', envVar: 'KILOCODE_PATH', color: '#14B8A6',
    win32: ['%APPDATA%\\npm\\kilo.cmd', '%LOCALAPPDATA%\\pnpm\\kilo.exe', '%USERPROFILE%\\.bun\\bin\\kilo.exe', '%USERPROFILE%\\.kilo\\bin\\kilo.exe'],
    darwin: ['~/.kilo/bin/kilo', '/usr/local/bin/kilo', '/opt/homebrew/bin/kilo', '~/.bun/bin/kilo', '~/.local/bin/kilo', '~/.npm-global/bin/kilo', '~/.local/share/pnpm/kilo'],
    linux: ['~/.kilo/bin/kilo', '/usr/local/bin/kilo', '/usr/bin/kilo', '~/.bun/bin/kilo', '~/.local/bin/kilo', '~/.npm-global/bin/kilo'],
    configDir: '~/.config/kilo', url: 'https://kilo.ai/docs/cli',
  }),
  cli({
    id: 'kimicode', name: 'Kimi Code', command: 'kimi', envVar: 'KIMI_CODE_PATH', color: '#2563EB',
    win32: ['%APPDATA%\\npm\\kimi.cmd', '%USERPROFILE%\\.kimi-code\\bin\\kimi.exe', '%USERPROFILE%\\.bun\\bin\\kimi.exe', '%LOCALAPPDATA%\\pnpm\\kimi.exe', '%USERPROFILE%\\.npm-global\\bin\\kimi.cmd'],
    darwin: ['~/.kimi-code/bin/kimi', '/opt/homebrew/bin/kimi', '/usr/local/bin/kimi', '~/.bun/bin/kimi', '~/.local/bin/kimi', '~/.npm-global/bin/kimi', '~/Library/pnpm/kimi'],
    linux: ['~/.kimi-code/bin/kimi', '/usr/local/bin/kimi', '/usr/bin/kimi', '~/.bun/bin/kimi', '~/.local/bin/kimi', '~/.npm-global/bin/kimi', '~/.local/share/pnpm/kimi'],
    configDir: '~/.kimi-code', url: 'https://moonshotai.github.io/kimi-code/',
  }),
  cli({
    id: 'mimocode', name: 'MiMo Code', command: 'mimo', envVar: 'MIMOCODE_PATH', color: '#F97316',
    win32: ['%APPDATA%\\npm\\mimo.cmd', '%USERPROFILE%\\.bun\\bin\\mimo.exe', '%LOCALAPPDATA%\\pnpm\\mimo.exe', '%USERPROFILE%\\.mimocode\\bin\\mimo.exe'],
    darwin: ['~/.mimocode/bin/mimo', '/usr/local/bin/mimo', '/opt/homebrew/bin/mimo', '~/.bun/bin/mimo', '~/.local/bin/mimo', '~/.npm-global/bin/mimo', '~/.local/share/pnpm/mimo'],
    linux: ['~/.mimocode/bin/mimo', '/usr/local/bin/mimo', '/usr/bin/mimo', '~/.bun/bin/mimo', '~/.local/bin/mimo', '~/.npm-global/bin/mimo', '~/.local/share/pnpm/mimo'],
    configDir: '~/.config/mimocode', url: 'https://mimo.xiaomi.com/mimocode/start',
  }),
  cli({
    id: 'openclaw', name: 'OpenClaw', command: 'openclaw', envVar: 'OPENCLAW_PATH', color: '#F43F5E',
    win32: ['%APPDATA%\\npm\\openclaw.cmd', '%LOCALAPPDATA%\\OpenClaw\\bin\\openclaw.exe', '%USERPROFILE%\\scoop\\shims\\openclaw.exe', '%LOCALAPPDATA%\\pnpm\\openclaw.exe', '%USERPROFILE%\\.local\\bin\\openclaw.exe'],
    darwin: ['/usr/local/bin/openclaw', '/opt/homebrew/bin/openclaw', '~/Library/pnpm/openclaw', '~/.local/bin/openclaw', '~/.bun/bin/openclaw', '~/.npm-global/bin/openclaw'],
    linux: ['/usr/local/bin/openclaw', '/usr/bin/openclaw', '~/.local/share/pnpm/openclaw', '~/.local/bin/openclaw', '~/.bun/bin/openclaw', '~/.npm-global/bin/openclaw'],
    configDir: '~/.openclaw', detectByConfigDir: true, url: 'https://docs.openclaw.ai',
  }),
  cli({
    id: 'opencode', name: 'OpenCode', command: 'opencode', envVar: 'OPENCODE_PATH', color: '#6366F1',
    win32: ['%APPDATA%\\npm\\opencode.cmd', '%LOCALAPPDATA%\\Programs\\opencode\\opencode.exe', '%USERPROFILE%\\scoop\\shims\\opencode.exe', '%PROGRAMDATA%\\chocolatey\\bin\\opencode.exe', '%ChocolateyInstall%\\bin\\opencode.exe', '%PROGRAMFILES%\\opencode\\opencode.exe', '%USERPROFILE%\\.bun\\bin\\opencode.exe', '%USERPROFILE%\\.opencode\\bin\\opencode.exe', '%LOCALAPPDATA%\\pnpm\\opencode.exe'],
    darwin: ['/usr/local/bin/opencode', '/opt/homebrew/bin/opencode', '~/.bun/bin/opencode', '~/.local/bin/opencode', '~/.opencode/bin/opencode', '~/.npm-global/bin/opencode', '~/.local/share/pnpm/opencode'],
    linux: ['/usr/local/bin/opencode', '/usr/bin/opencode', '~/.bun/bin/opencode', '~/.local/bin/opencode', '~/.opencode/bin/opencode', '~/.npm-global/bin/opencode', '~/.local/share/pnpm/opencode'],
    configDir: '~/.config/opencode', url: 'https://opencode.ai/docs#install',
  }),
  gui({
    id: 'opencodedesktop', name: 'OpenCode 桌面端', color: '#4F46E5',
    win32: ['%LOCALAPPDATA%\\Programs\\OpenCode\\OpenCode.exe', '%LOCALAPPDATA%\\Programs\\opencode\\OpenCode.exe', '%LOCALAPPDATA%\\Programs\\OpenCode Beta\\OpenCode Beta.exe'],
    darwin: ['/Applications/OpenCode.app/Contents/MacOS/OpenCode', '/Applications/OpenCode Beta.app/Contents/MacOS/OpenCode Beta'],
    linux: ['/opt/OpenCode/opencode', '~/.local/bin/opencode-desktop'],
    registryHints: { windowsDisplayNamePrefixes: ['OpenCode'] },
    url: 'https://opencode.ai/download',
  }),
  cli({
    id: 'openscience', name: 'OpenScience', command: 'openscience', color: '#0EA5E9',
    win32: ['%APPDATA%\\npm\\openscience.cmd', '~\\.openscience\\bin\\openscience.exe'],
    darwin: ['~/.openscience/bin/openscience', '/usr/local/bin/openscience'],
    linux: ['~/.openscience/bin/openscience', '~/.local/bin/openscience', '/usr/local/bin/openscience', '/usr/bin/openscience'],
    configDir: '~/.config/openscience', url: 'https://www.openscience.sh/docs',
  }),
  cli({
    id: 'qwencode', name: 'QwenCode', command: 'qwen', color: '#10B981',
    win32: ['%APPDATA%\\npm\\qwen.cmd', '%USERPROFILE%\\.local\\bin\\qwen.exe', '%USERPROFILE%\\.bun\\bin\\qwen.exe', '%USERPROFILE%\\scoop\\shims\\qwen.exe', '%LOCALAPPDATA%\\pnpm\\qwen.exe'],
    darwin: ['/usr/local/bin/qwen', '/opt/homebrew/bin/qwen', '~/.bun/bin/qwen', '~/.local/bin/qwen', '~/.npm-global/bin/qwen', '~/Library/pnpm/qwen'],
    linux: ['/usr/local/bin/qwen', '/usr/bin/qwen', '~/.bun/bin/qwen', '~/.local/bin/qwen', '~/.npm-global/bin/qwen', '~/.local/share/pnpm/qwen'],
    configDir: '~/.qwen', url: 'https://qwenlm.github.io/qwen-code-docs/en/users/overview',
  }),
  gui({
    id: 'trae', name: 'Trae', color: '#F97316',
    win32: ['%LOCALAPPDATA%\\Programs\\Trae\\Trae.exe'],
    darwin: ['/Applications/Trae.app/Contents/MacOS/Trae'],
    linux: [],
    registryHints: { windowsDisplayNames: ['Trae'], windowsPublisher: 'Bytedance' },
    url: 'https://www.trae.ai/',
  }),
  gui({
    id: 'traecn', name: 'Trae CN', color: '#EA580C',
    win32: ['%LOCALAPPDATA%\\Programs\\Trae CN\\Trae CN.exe', '%LOCALAPPDATA%\\Programs\\Trae-CN\\Trae CN.exe'],
    darwin: ['/Applications/Trae CN.app/Contents/MacOS/Trae CN'],
    linux: [],
    registryHints: { windowsDisplayNames: ['Trae CN'], windowsPublisher: 'Bytedance' },
    url: 'https://www.trae.cn/',
  }),
];

module.exports = DETECTION_CATALOG;

