'use strict';
// Claude Code 适配器：解析 ~/.claude/projects/<escaped-path>/<uuid>.jsonl
const path = require('path');
const os = require('os');
const { collectFiles, readAll, tailRead } = require('../watcher');

const ID = 'claude';
const ROOT = path.join(os.homedir(), '.claude', 'projects');

function isSessionFile(p) { return p.endsWith('.jsonl'); }

const CHILD_FILE_RE = /[\\/]([^\\/]+)[\\/]subagents[\\/]agent-([^\\/]+)\.jsonl$/i;

function claudeFileTopology(filePath, line = {}) {
  const match = String(filePath || '').match(CHILD_FILE_RE);
  if (!match) {
    return {
      sessionId: String(line.sessionId || ''),
      sessionRole: 'main',
      rootSessionId: String(line.sessionId || ''),
      topologySource: 'structural',
      topologyConfidence: 1,
      childDetection: 'verified',
      controlEligibility: 'eligible',
    };
  }
  const parentSessionId = match[1].trim();
  const agentId = match[2].trim();
  const childSessionId = parentSessionId && agentId
    ? `${parentSessionId}:subagent:${agentId}`
    : (agentId || parentSessionId);
  return {
    sessionId: childSessionId,
    sessionRole: 'child',
    parentSessionId,
    rootSessionId: parentSessionId,
    topologySource: 'explicit',
    topologyConfidence: 1,
    childDetection: 'verified',
    controlEligibility: 'blocked',
  };
}

function extractText(content) {
  // Claude Code 的 content 可能是数组 [{type:'text',text}] 也可能是纯字符串（新版本）
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const c of content) {
    if (!c || typeof c !== 'object') continue;
    if (c.type === 'text' && c.text) parts.push(c.text);
    else if (c.type === 'input_text' && c.text) parts.push(c.text); // 兼容新格式
  }
  return parts.join('\n').trim();
}

function parseLines(lines, filePath = '') {
  const out = [];
  for (const line of lines) {
    try {
      const topology = claudeFileTopology(filePath, line);
      // 官方会话标题行（Claude Code custom-title）；该行无 timestamp，缺失时用 0 不推高 last_seen
      if (line.type === 'custom-title' && line.sessionId && line.customTitle) {
        out.push({
          agent: ID, sourceId: `title:${topology.sessionId}`,
          sessionId: topology.sessionId, ts: 0,
          role: 'system', kind: 'title', text: '', title: String(line.customTitle).trim(),
          project: line.cwd || '',
          ...topology,
        });
        continue;
      }
      if (line.type !== 'user' && line.type !== 'assistant' && line.type !== 'summary') continue;
      if (!line.message || !line.sessionId) continue;
      const text = extractText(line.message.content);
      // timestamp 缺失/非法时跳过该行（绝不用 Date.now() 兜底，否则会把老会话顶到今天）
      const ts = Date.parse(line.timestamp);
      if (!ts) continue;
      const role = line.type === 'summary' ? 'assistant' : line.type;
      const sourceId = line.uuid || (topology.sessionId + ':' + line.timestamp + ':' + Math.random());
      out.push({
        agent: ID,
        sourceId,
        sessionId: topology.sessionId,
        ts,
        role,
        kind: line.type === 'summary' ? 'summary' : 'message',
        text,
        project: line.cwd || '',
        ...topology,
      });
      // 回合结束显式信号：assistant 消息 stop_reason !== 'tool_use' = 本轮未再调用工具、
      // 交还控制权给用户（真正回合结束）；isSidechain（Task 子代理）排除，否则子代理收尾
      // 会把主会话误判成已完成。
      if (role === 'assistant' && !line.isSidechain) {
        const stopReason = line.message.stop_reason;
        if (stopReason && stopReason !== 'tool_use') {
          out.push({
            agent: ID, sourceId: `${sourceId}:turnend`, sessionId: topology.sessionId, ts, kind: 'turn_end',
            ...topology,
          });
        }
      }
    } catch { /* skip */ }
  }
  return out;
}

// 返回 sessionId -> project 映射（用文件所在目录推断 cwd，作为兜底）
function sessionProjectMap() {
  const map = {};
  for (const f of collectFiles(ROOT, isSessionFile)) {
    const dir = path.basename(path.dirname(f));
    map[dir] = dir;
  }
  return map;
}

function fileToSessionId(file) {
  return claudeFileTopology(file).sessionId || path.basename(file).replace(/\.jsonl$/, '');
}

// 探测/安装配置（agent-board 设置页"应用管理"用）。命令取自 EchoBird 官方安装定义
// docs/api/tools/install/claudecode.json，路径列表取自其 tools/claudecode/paths.json。
const detect = {
  tier: 'cli',
  identityGuard: {
    description: 'Claude Code 是 Anthropic 官方的命令行 coding agent',
    notToConfuseWith: ['Claude Desktop（图形界面版）', 'Claude.ai 网页版'],
  },
  requirements: {},
  probe: {
    kind: 'path',
    executable: true,
    command: 'claude',
    win32: [
      '%USERPROFILE%\\.local\\bin\\claude.exe',
      '%APPDATA%\\npm\\claude.cmd',
      '%USERPROFILE%\\.bun\\bin\\claude.exe',
      '%LOCALAPPDATA%\\Microsoft\\WinGet\\Links\\claude.exe',
      '%LOCALAPPDATA%\\pnpm\\claude.exe',
    ],
    darwin: [
      '/usr/local/bin/claude', '/opt/homebrew/bin/claude', '~/.local/bin/claude',
      '~/.bun/bin/claude', '~/.npm-global/bin/claude', '~/Library/pnpm/claude',
    ],
    linux: [
      '/usr/local/bin/claude', '/usr/bin/claude', '~/.local/bin/claude',
      '~/.bun/bin/claude', '~/.npm-global/bin/claude', '~/.local/share/pnpm/claude',
    ],
  },
  // Claude Desktop 与 Claude Code CLI 是两个不同产品：桌面端只用于 GUI 启动，
  // 不能写入 tool-paths.json，也不能拿它执行 claude --version。
  desktopProbe: {
    probe: {
      kind: 'path',
      executable: true,
      launchUri: 'shell:AppsFolder\\Claude_pzs8sxrjxfjjc!Claude',
      win32: [
        '%LOCALAPPDATA%\\AnthropicClaude\\claude.exe',
        '%LOCALAPPDATA%\\Programs\\Claude\\Claude.exe',
        '%LOCALAPPDATA%\\Claude\\Claude.exe',
        // 当前机器已验证的 MSIX 主程序；版本升级后由通配符候选继续兜底。
        '%PROGRAMFILES%\\WindowsApps\\Claude_1.37937.1.0_x64__pzs8sxrjxfjjc\\app\\claude.exe',
        // 官方 Windows 安装器当前通常是 MSIX，主程序位于受保护的
        // WindowsApps 版本目录；它不是 Claude Code CLI，不能写入 CLI override。
        '%PROGRAMFILES%\\WindowsApps\\Claude_*_x64__pzs8sxrjxfjjc\\app\\Claude.exe',
      ],
      darwin: [
        '/Applications/Claude.app/Contents/MacOS/Claude',
        '~/Applications/Claude.app/Contents/MacOS/Claude',
      ],
      registryHints: {
        windowsDisplayNames: ['Claude'],
        windowsPublisher: 'Anthropic',
      },
    },
  },
  install: {
    methods: [
      { kind: 'download', url: 'https://code.claude.com/docs/en/installation' },
    ],
    warning: '请在官方下载页完成安装；Agent Board 不会执行第三方安装命令',
  },
  network: {
    testUrls: ['https://claude.ai', 'https://github.com/anthropics/claude-code'],
    mirrors: {},
    blockedRegions: {
      'zh-CN': 'Claude Code 需要直连 claude.ai，中国大陆访问被墙，没有镜像替代方案，没有代理/VPN 基本无法安装成功',
    },
  },
  verify: { cmd: 'claude --version' },
  afterInstall: {
    tellUser: ['用的是哪种安装方式（原生安装器/winget/npm）', '首次使用需要在终端里自己完成登录/onboarding，agent-board 不会替你自动跳过'],
  },
};

module.exports = {
  ID, ROOT, isSessionFile, parseLines, fileToSessionId, claudeFileTopology, detect,
  scanAll(store) {
    const files = collectFiles(ROOT, isSessionFile);
    let count = 0;
    for (const f of files) {
      const key = `offset:${ID}:${f}`;
      const offset = Number(store.stmts.getMeta.get(key)?.v || 0);
      const { lines, newOffset } = readAll(f, offset);
      if (lines.length) {
        for (const m of parseLines(lines, f)) { store.ingest(m); count++; }
      }
      store.stmts.setMeta.run(key, String(newOffset));
    }
    return count;
  },
  poll(store, changedPaths) {
    let count = 0;
    const files = changedPaths.filter(isSessionFile);
    for (const f of files) {
      const key = `offset:${ID}:${f}`;
      const offset = Number(store.stmts.getMeta.get(key)?.v || 0);
      const { lines, newOffset } = tailRead(f, offset);
      if (lines.length) {
        const msgs = parseLines(lines, f);
        for (const m of msgs) { store.ingest(m); count++; }
        // 活跃信号：watch 触发 = 文件确实在写入 = Claude 正在运行。
        // 用当前时间而非消息时间戳——消息写入间隔（思考/工具执行/等响应）可能超过活跃窗口，
        // 若用旧消息时间戳会导致 lastActivity 掉出窗口 → 状态反复闪烁。
        if (msgs.length) {
          const last = msgs[msgs.length - 1];
          store.touchActive(`${ID}:${last.sessionId}`, { agent: ID, project: last.project }, Date.now());
        }
      }
      store.stmts.setMeta.run(key, String(newOffset));
    }
    return count;
  },
};
