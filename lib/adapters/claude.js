'use strict';
// Claude Code 适配器：解析 ~/.claude/projects/<escaped-path>/<uuid>.jsonl
const fs = require('fs');
const path = require('path');
const { collectFiles, readAll, tailRead } = require('../watcher');
const { SOURCE_PATHS } = require('../source-paths');

const ID = 'claude';
const ROOT = SOURCE_PATHS.claude;

function isSessionFile(p) { return p.endsWith('.jsonl'); }

function fileOffsetKey(filePath) {
  return `offset:topology-v2:${ID}:${filePath}`;
}

// 文件路径 → 行内真实 sessionId（停顿检测要构造与 ingest 一致的 ref；claude 文件名=uuid，
// 但行内 sessionId 字段才是看板 ref 的真实来源）。parseLines 写入，停顿检测读取兜底首行。
const sessionIdByFile = new Map();

function readFirstSessionId(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    if (size <= 0) return '';
    const buf = Buffer.alloc(Math.min(size, 1024 * 1024));
    fs.readSync(fd, buf, 0, buf.length, 0);
    const text = buf.toString('utf8');
    for (const raw of text.split(/\r?\n/)) {
      if (!raw.trim()) continue;
      try {
        const row = JSON.parse(raw);
        if (typeof row.sessionId === 'string' && row.sessionId) {
          sessionIdByFile.set(file, row.sessionId);
          return row.sessionId;
        }
      } catch { /* skip malformed lines */ }
    }
  } catch { /* file may be concurrently removed */ }
  finally { if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } } }
  return '';
}

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
      if (topology.sessionId) sessionIdByFile.set(filePath, topology.sessionId);
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
  const cached = sessionIdByFile.get(file);
  if (cached) return cached;
  const fromFile = claudeFileTopology(file).sessionId;
  return fromFile || readFirstSessionId(file) || path.basename(file).replace(/\.jsonl$/, '');
}

// —— 桌面/托管常驻 Claude Code 的「停顿检测」——
// Claude Code CLI 由桌面宿主常驻启动时进程名不可靠（server.js PROC_PATTERNS 的 claude.exe
// 只覆盖原生 CLI），宿主进程不退 → allowStop 完成弹窗永不触发。补与 workbuddy/deepseek 同款
// 停顿检测：jsonl 文件静止 >40s + 最后真实消息是 assistant + 末行是「完整回合结束」
// （type=assistant 且 message.stop_reason 非 tool_use）→ 判停笔 → setAgentActive(ref,false)
// → store 通用出口 allowStop → 3s 兜底窗广播完成弹窗。末行防线避免工具循环/思考中误判。
const DESKTOP_IDLE_MS = 40 * 1000;
const DESKTOP_FRESH_MS = 30 * 1000;
const DESKTOP_DEBOUNCE_MS = 20 * 1000;
const deskIdleSince = new Map();

// 读文件尾部最后一行并解析出 claude 语义（type + stop_reason）；尾部 128KB 足够覆盖绝大多数行。
// 无法解析 / 末行缺失 → null（保守不判停）。
function getLastTurnMeta(f) {
  let fd = null;
  try {
    fd = fs.openSync(f, 'r');
    const size = fs.fstatSync(fd).size;
    if (size <= 0) return null;
    const buf = Buffer.alloc(Math.min(size, 128 * 1024));
    fs.readSync(fd, buf, 0, buf.length, Math.max(0, size - buf.length));
    const text = buf.toString('utf8');
    const tail = text.endsWith('\n') ? text.slice(0, -1) : text;
    const idx = tail.lastIndexOf('\n');
    const lastLine = (idx >= 0 ? tail.slice(idx + 1) : tail).trim();
    if (!lastLine) return null;
    const o = JSON.parse(lastLine);
    if (!o || typeof o !== 'object') return null;
    return {
      type: typeof o.type === 'string' ? o.type : null,
      stopReason: o.message && typeof o.message.stop_reason === 'string' ? o.message.stop_reason : null,
    };
  } catch { return null; }
  finally { if (fd) { try { fs.closeSync(fd); } catch { /* ignore */ } } }
}

function checkDesktopIdle(store) {
  if (!fs.existsSync(ROOT)) return;
  const now = Date.now();
  let files;
  try { files = collectFiles(ROOT, isSessionFile); } catch { return; }
  for (const f of files) {
    let st;
    try { st = fs.statSync(f); } catch { continue; }
    const ref = `${ID}:${fileToSessionId(f)}`;
    const idle = now - st.mtimeMs;
    const lastRole = store.getLastRole(ref);
    if (lastRole !== 'assistant') {
      // 最后真实消息是 user（agent 尚未回复）：文件在写 = agent 已恢复
      if (idle < DESKTOP_FRESH_MS) store.setAgentActive(ref, true, now);
      deskIdleSince.delete(ref);
      continue;
    }
    if (idle < DESKTOP_FRESH_MS) {
      // 正在写 = 在跑：清除停止标记（可能刚 resume）
      store.setAgentActive(ref, true, now);
      deskIdleSince.delete(ref);
    } else if (idle > DESKTOP_IDLE_MS) {
      // 末行防线：仅当末行是「完整回合结束」才判停笔（stop_reason 非 tool_use = 已交还控制权）。
      // 末行是 user（等输入）/ assistant+tool_use（工具循环中）/ summary 等 → 交给 10 分钟窗口兜底。
      const meta = getLastTurnMeta(f);
      const settled = Boolean(meta && meta.type === 'assistant' && meta.stopReason && meta.stopReason !== 'tool_use');
      if (!settled) { deskIdleSince.delete(ref); continue; }
      const first = deskIdleSince.get(ref) || now;
      deskIdleSince.set(ref, first);
      // debounce：连续 2 次（≥20s）都疑似停笔才真正判停，避免单次 stat 抖动误判
      if (now - first >= DESKTOP_DEBOUNCE_MS) store.setAgentActive(ref, false, now);
    } else {
      deskIdleSince.delete(ref); // 30~40s 中间地带：可能只是思考间隙，重置
    }
  }
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
  ID, ROOT, isSessionFile, parseLines, fileToSessionId, claudeFileTopology, fileOffsetKey, detect,
  checkDesktopIdle, getLastTurnMeta,
  scanAll(store) {
    const files = collectFiles(ROOT, isSessionFile);
    let count = 0;
    for (const f of files) {
      const key = fileOffsetKey(f);
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
      const key = fileOffsetKey(f);
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
