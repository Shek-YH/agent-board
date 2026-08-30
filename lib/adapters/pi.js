'use strict';
// Pi Agent (earendil-works/pi-coding-agent) 适配器
// 数据源：~/.pi/agent/sessions/<escaped-cwd>/<timestamp>_<uuid>.jsonl (JSONL 追加式)
// 行结构：
//   {"type":"session","id":...,"timestamp":"ISO","cwd":"C:\\Users\\..."}  ← 会话元数据（cwd=项目路径）
//   {"type":"model_change"|"thinking_level_change",...}                  ← 忽略
//   {"type":"message","id":"496a2a72","timestamp":"ISO","message":{
//      "role":"user"|"assistant"|"toolResult",
//      "timestamp":1787333006608,                                        ← 毫秒，优先用
//      "content":[{"type":"text","text":"..."}|{"type":"thinking","thinking":"..."}|{"type":"toolCall",...}]
//   }}
const path = require('path');
const fs = require('fs');
const { collectFiles, readAll, tailRead } = require('../watcher');
const { SOURCE_PATHS } = require('../source-paths');

const ID = 'pi';
const ROOT = SOURCE_PATHS.pi;

function isSessionFile(p) { return p.endsWith('.jsonl'); }

function fileOffsetKey(filePath) {
  return `offset:topology-v2:${ID}:${filePath}`;
}

// @johnnywu/pi-subagents 将持久化子会话放在 parent/subagents/<child>.jsonl。
// Pi 核心的 parentSession 也用于 fork/clone，因此只能把目录结构作为 child 证据。
const CHILD_FILE_RE = /[\\/]subagents[\\/][^\\/]+\.jsonl$/i;

// 文件名 <ISO时间戳>_<uuid>.jsonl → 直接取完整 basename 去扩展名（含时间戳前缀，跨会话唯一）
const sessionIdsByFile = new Map();

function readSessionHeader(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(64 * 1024);
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const firstLine = buffer.toString('utf8', 0, bytes).split(/\r?\n/, 1)[0].trim();
    const header = JSON.parse(firstLine);
    return header && header.type === 'session' ? header : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function readSessionHeaderId(file) {
  const header = readSessionHeader(file);
  return header && typeof header.id === 'string' && header.id ? header.id : null;
}

function rememberSessionId(filePath, sessionId) {
  if (typeof sessionId !== 'string') return '';
  const normalized = sessionId.trim();
  const key = String(filePath || '');
  if (key && normalized) sessionIdsByFile.set(key, normalized);
  return normalized;
}

function fallbackSessionId(filePath) {
  return path.basename(String(filePath || '')).replace(/\.jsonl$/i, '');
}

function piFileTopology(filePath, header = {}) {
  const source = header && typeof header === 'object' && Object.keys(header).length
    ? header : (readSessionHeader(filePath) || {});
  const sessionId = rememberSessionId(filePath, source.id) || fallbackSessionId(filePath);
  if (!CHILD_FILE_RE.test(String(filePath || ''))) {
    return {
      sessionId,
      sessionRole: 'main',
      rootSessionId: sessionId,
      topologySource: 'structural',
      topologyConfidence: 1,
      childDetection: 'verified',
      controlEligibility: 'eligible',
    };
  }

  const parentSessionId = String(source.parentSession || '').trim();
  return {
    sessionId,
    sessionRole: 'child',
    ...(parentSessionId ? { parentSessionId, rootSessionId: parentSessionId } : {}),
    topologySource: 'structural',
    topologyConfidence: 1,
    childDetection: 'verified',
    controlEligibility: 'blocked',
  };
}

function fileToSessionId(file) {
  const cached = sessionIdsByFile.get(file);
  if (cached) return cached;
  const headerId = readSessionHeaderId(file);
  if (headerId) {
    rememberSessionId(file, headerId);
    return headerId;
  }
  return path.basename(file).replace(/\.jsonl$/, '');
}

function resolveSessionId(sessionId, files = collectFiles(ROOT, isSessionFile)) {
  if (typeof sessionId !== 'string' || !sessionId) return sessionId;
  const legacyFile = files.find((file) => path.basename(file).replace(/\.jsonl$/, '') === sessionId);
  return legacyFile ? fileToSessionId(legacyFile) : sessionId;
}

// 只取 text 正文；thinking（字段名是 thinking）/toolCall 不展示
function extractText(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const c of content) {
    if (!c || typeof c !== 'object') continue;
    if (c.type === 'text' && c.text) parts.push(String(c.text));
  }
  return parts.join('\n').trim();
}

function parseLines(lines, filePath) {
  const out = [];
  const header = lines.find((line) => line && line.type === 'session') || readSessionHeader(filePath) || {};
  const topology = piFileTopology(filePath, header);
  const sid = topology.sessionId || fileToSessionId(filePath);
  let project = String(header.cwd || ''); // 由本文件 session 行的 cwd 决定
  let title = String(header.title || '').trim();
  lines.forEach((line, idx) => {
    try {
      if (line.type === 'session') {
        if (line.cwd) project = line.cwd;
        if (!title && line.title) title = String(line.title).trim();
        return;
      }
      if (line.type !== 'message') return;
      const m = line.message || {};
      if (!m || !m.content) return;
      // 时间戳：message.timestamp 毫秒优先；行级 ISO 兜底；缺失/非法跳过（绝不用 Date.now()）
      let ts = Number(m.timestamp);
      if (!Number.isFinite(ts) || !ts) ts = Date.parse(line.timestamp);
      if (!ts) return;
      // 回合结束显式信号：stopReason==='stop' 且本条不含 toolCall = 本轮未再调用工具，
      // 真正交还控制权（stopReason==='toolUse' 表示还会继续，非终态）。放在 !text 判断之前，
      // 因为终态消息即便没有可展示正文（纯 toolResult 收尾等罕见情况）也不能漏判。
      if (m.role === 'assistant' && m.stopReason === 'stop') {
        const hasToolCall = Array.isArray(m.content) && m.content.some((c) => c && c.type === 'toolCall');
        if (!hasToolCall) {
          out.push({
            agent: ID, sourceId: `${sid}:${line.id || idx}:turnend`, sessionId: sid, ts, kind: 'turn_end',
            ...topology,
          });
        }
      }
      const text = extractText(m.content);
      if (!text) return;
      // toolResult 归为 assistant（看板只有 user/assistant 两态）
      const role = m.role === 'user' ? 'user' : 'assistant';
      out.push({
        agent: ID,
        sourceId: `${sid}:${line.id || idx}`, // 会话内唯一（message.id 短 id，跨会话可能重复，加会话前缀）
        sessionId: sid, ts, role, kind: 'message', text, project,
        ...topology,
      });
    } catch { /* skip */ }
  });
  if (title && sid) {
    out.unshift({
      agent: ID, sourceId: `title:${sid}`, sessionId: sid, ts: 0,
      role: 'system', kind: 'title', text: '', title, project,
      ...topology,
    });
  }
  return out;
}

// 探测/安装配置。命令取自 EchoBird 官方安装定义 docs/api/tools/install/pi.json，
// 路径列表取自其 tools/pi/paths.json。
const detect = {
  tier: 'cli',
  identityGuard: {
    description: 'Pi 指 Earendil Works 开发的开源 CLI coding agent（pi.dev）',
    notToConfuseWith: ['Pi Network（加密货币 App）', 'Inflection AI 的 Pi 助手', 'Raspberry Pi 相关工具'],
  },
  requirements: { node: '>=22.19.0' },
  probe: {
    kind: 'path',
    executable: true,
    command: 'pi',
    win32: [
      '%APPDATA%\\npm\\pi.cmd',
      '%USERPROFILE%\\.local\\bin\\pi.exe',
      '%USERPROFILE%\\.bun\\bin\\pi.exe',
      '%USERPROFILE%\\.hermes\\node\\bin\\pi.exe',
      '%USERPROFILE%\\.hermes\\node\\bin\\pi.cmd',
      '%LOCALAPPDATA%\\pnpm\\pi.exe',
    ],
    darwin: [
      '/usr/local/bin/pi', '/opt/homebrew/bin/pi', '~/.hermes/node/bin/pi',
      '~/.bun/bin/pi', '~/.local/bin/pi', '~/.npm-global/bin/pi', '~/Library/pnpm/pi',
    ],
    linux: [
      '/usr/local/bin/pi', '/usr/bin/pi', '~/.local/bin/pi', '~/.hermes/node/bin/pi',
      '~/.bun/bin/pi', '~/.npm-global/bin/pi', '~/.local/share/pnpm/pi',
    ],
  },
  install: {
    methods: [
      { kind: 'download', url: 'https://pi.dev/' },
    ],
    warning: '请在 Pi 官方页面完成安装；Agent Board 不会执行第三方安装命令',
  },
  network: {
    testUrls: ['https://pi.dev', 'https://registry.npmjs.org/@earendil-works/pi-coding-agent'],
    mirrors: { npm: 'https://registry.npmmirror.com' },
    blockedRegions: {},
  },
  verify: { cmd: 'pi --version' },
  afterInstall: {
    tellUser: ['用的是 curl 安装器还是 npm（Windows 走 npm，需要先有 Node.js ≥18）', '装完可能要点"刷新"或重启 agent-board 才能识别到新装的 pi'],
  },
};

module.exports = {
  ID, ROOT, isSessionFile, parseLines, readSessionHeader, piFileTopology, fileOffsetKey,
  fileToSessionId, resolveSessionId, detect,
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
        // 活跃信号：watch 触发 = 文件在写入 = Pi 正在运行，用当前时间（避免旧消息时间戳掉出窗口）
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
