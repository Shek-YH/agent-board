'use strict';
// Codex 适配器：解析 ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
// 兼容两代格式：
//   老 CLI: {timestamp, type:'user_message'|'agent_message'|'summary', payload:{text}}
//   新 Desktop(v0.14x+): {timestamp, type:'response_item', payload:{type:'message', role, content:[{type:'input_text'|'output_text', text}]}}
const path = require('path');
const os = require('os');
const fs = require('fs');
const { collectFiles, readAll, tailRead } = require('../watcher');

const ID = 'codex';
const ROOT = path.join(os.homedir(), '.codex', 'sessions');
const SESSION_INDEX = path.join(os.homedir(), '.codex', 'session_index.jsonl');
const SINGLE_TURN_HOLD_MS = 5 * 1000;
const MULTI_TURN_DEFAULT_HOLD_MS = 10 * 1000;
const RAPID_CONTINUATION_MAX_MS = 180 * 1000;
const COMPLETION_BUFFER_MS = 6 * 1000;
const MAX_PREDICTED_HOLD_MS = 60 * 1000;
const completionHistoryCache = new Map();

function isSessionFile(p) { return p.endsWith('.jsonl'); }

function parseSessionIndexLines(lines) {
  const titles = new Map();
  for (const line of lines) {
    try {
      const sessionId = String(line && line.id || '').trim();
      const title = typeof (line && line.thread_name) === 'string' ? line.thread_name.trim() : '';
      if (sessionId && title) titles.set(sessionId, title);
    } catch { /* skip malformed index entries */ }
  }
  return titles;
}

function readSessionIndexTitles() {
  try {
    const lines = fs.readFileSync(SESSION_INDEX, 'utf8')
      .split(/\r?\n/)
      .filter((raw) => raw.trim())
      .map((raw) => JSON.parse(raw));
    return parseSessionIndexLines(lines);
  } catch {
    return null;
  }
}

let sessionIndexSignature = '';
let sessionIndexTitles = new Map();
const sessionIndexRefs = new Map();

function applySessionIndexTitles(store, titles) {
  let count = 0;
  for (const [sessionId, title] of titles) {
    let ref = sessionIndexRefs.get(sessionId);
    if (!ref) {
      ref = store.resolveAgentRef(ID, sessionId);
      if (ref) sessionIndexRefs.set(sessionId, ref);
    }
    if (!ref) continue;
    const currentTitle = typeof store.getSessionTitle === 'function'
      ? store.getSessionTitle(ref)
      : store.getSession(ref)?.title;
    if (currentTitle === undefined) {
      sessionIndexRefs.delete(sessionId);
      continue;
    }
    if (currentTitle === title) continue;
    store.ingest({
      agent: ID,
      sourceId: `index-title:${sessionId}`,
      sessionId: ref.slice(ID.length + 1),
      ts: 0,
      role: 'system',
      kind: 'title',
      text: '',
      title,
    });
    count++;
  }
  return count;
}

function syncSessionTitles(store) {
  let stat;
  try { stat = fs.statSync(SESSION_INDEX); } catch { return 0; }
  const signature = `${stat.size}:${stat.mtimeMs}`;
  if (signature !== sessionIndexSignature) {
    const titles = readSessionIndexTitles();
    if (!titles) return 0;
    sessionIndexTitles = titles;
    sessionIndexSignature = signature;
  }
  return applySessionIndexTitles(store, sessionIndexTitles);
}

// 每个 rollout 文件 = 一个会话，直接用文件名做 sessionId（跨版本最稳定）
function sessionIdFromPath(p) {
  return path.basename(p).replace(/\.jsonl$/, '').replace(/^rollout-/, '');
}

function extractPayloadText(pl) {
  if (!pl || typeof pl !== 'object') return '';
  if (typeof pl.text === 'string' && pl.text.trim()) return pl.text.trim();
  if (typeof pl.message === 'string') return pl.message.trim();
  if (typeof pl.summary === 'string') return pl.summary.trim();
  if (typeof pl.command === 'string') return '› ' + pl.command.trim();
  return '';
}

// 新格式 content 数组（与 WorkBuddy 同构）
function extractContentText(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const c of content) {
    if (!c || typeof c !== 'object') continue;
    if ((c.type === 'input_text' || c.type === 'output_text' || c.type === 'text') && c.text) {
      parts.push(c.text);
    }
  }
  return parts.join('\n').trim();
}

// Codex Desktop 把 system context（system prompt / 推荐插件 / 权限说明）以 user role
// 写入 jsonl，特征是整段内容被 <recommended_plugins> / <permissions instructions> /
// <collaboration_mode> / <plugins_instructions> / <apps_instructions> / <environment_context>
// 等标签包裹。识别并跳过这些"假 user"消息，避免 board 把它们当用户首条指令。
const SYSTEM_CONTEXT_TAGS = [
  '<recommended_plugins>',
  '<permissions instructions>',
  '<collaboration_mode>',
  '<plugins_instructions>',
  '<apps_instructions>',
  '<environment_context>',
  '<sandbox_requirements>',
  '<memory_instructions>',
];
function isSystemContextMessage(text) {
  if (!text) return false;
  // 整段内容是单一 XML 包裹的系统注入（含开头标签）→ 跳过
  return SYSTEM_CONTEXT_TAGS.some((tag) => text.includes(tag));
}

function isDefinitiveContinuationLine(line) {
  if (!line || !line.payload) return false;
  if (line.type === 'event_msg' && line.payload.type === 'task_started') return true;
  if (line.type !== 'response_item' || line.payload.type !== 'message' || line.payload.role !== 'user') return false;
  const text = extractContentText(line.payload.content);
  return Boolean(text && !isSystemContextMessage(text));
}

function eventTime(event) {
  if (Number.isFinite(event && event.ts)) return event.ts;
  return Date.parse(event && event.timestamp) || 0;
}

// 单回合 session 不需要沿用多回合 session 的长观察期。
// 多回合只参考当前完成事件之前已经发生过的接续，避免读取未来日志造成误判。
function completionHoldMsForHistory(events, signalTs) {
  const signal = Number(signalTs) || 0;
  const taskEvents = events.filter((event) => {
    const type = event && event.type === 'event_msg' ? event.payload && event.payload.type : '';
    return (type === 'task_started' || type === 'task_complete') && eventTime(event) <= signal;
  });
  const starts = taskEvents.filter((event) => event.payload.type === 'task_started').map(eventTime).sort((a, b) => a - b);
  if (starts.length <= 1) return SINGLE_TURN_HOLD_MS;

  const completes = taskEvents.filter((event) => event.payload.type === 'task_complete').map(eventTime).sort((a, b) => a - b);
  const rapidGaps = [];
  for (const complete of completes) {
    const nextStart = starts.find((start) => start > complete);
    if (!nextStart) continue;
    const gap = nextStart - complete;
    if (gap >= 0 && gap <= RAPID_CONTINUATION_MAX_MS) rapidGaps.push(gap);
  }
  if (!rapidGaps.length) return MULTI_TURN_DEFAULT_HOLD_MS;
  return Math.min(MAX_PREDICTED_HOLD_MS, Math.max(MULTI_TURN_DEFAULT_HOLD_MS, Math.max(...rapidGaps) + COMPLETION_BUFFER_MS));
}

function completionHoldMsForSession(filePath, signalTs, fallbackEvents) {
  let events = fallbackEvents;
  try {
    const stat = fs.statSync(filePath);
    const cacheKey = `${stat.size}:${stat.mtimeMs}`;
    const cached = completionHistoryCache.get(filePath);
    if (cached && cached.key === cacheKey) {
      events = cached.events;
    } else {
      events = fs.readFileSync(filePath, 'utf8').split('\n')
        .map((raw) => { try { return raw.trim() ? JSON.parse(raw) : null; } catch { return null; } })
        .filter(Boolean);
      completionHistoryCache.set(filePath, { key: cacheKey, events });
    }
  } catch { /* 测试路径或文件刚被删除时使用当前批次 */ }
  return completionHoldMsForHistory(events, signalTs);
}

function parseLines(lines, filePath) {
  const out = [];
  const sid = sessionIdFromPath(filePath);
  lines.forEach((line, idx) => {
    try {
      const t = line.type;
      const pl = line.payload || {};
      const ts = Date.parse(line.timestamp); // 缺失/非法 → NaN，消息行会跳过（不误标今天）

      if (t === 'session_meta' && pl.cwd) {
        out.push({ agent: ID, sourceId: `${sid}:meta`, sessionId: sid, ts: ts || 0, role: 'system', kind: 'heartbeat', text: '', project: pl.cwd || '' });
        return;
      }
      // task_complete 是 Codex Desktop 的单轮响应边界。store 会按 session 历史观察：
      // 后续日志继续写入则取消完成；没有新日志才将整个 session 标为完成。
      if (t === 'event_msg' && pl.type === 'task_complete' && ts) {
        const completionHoldMs = completionHoldMsForSession(filePath, ts, lines);
        out.push({ agent: ID, sourceId: `${sid}:${ts}:turnend`, sessionId: sid, ts, kind: 'turn_end', completionHoldMs });
        return;
      }
      if (!ts) return; // 消息行必须有时戳
      // 老格式
      if (t === 'user_message') {
        const text = extractPayloadText(pl);
        if (text) out.push({ agent: ID, sourceId: `${sid}:${ts}:${idx}:u`, sessionId: sid, ts, role: 'user', kind: 'message', text, project: pl.cwd || '' });
        return;
      }
      if (t === 'agent_message') {
        const text = extractPayloadText(pl);
        if (text) out.push({ agent: ID, sourceId: `${sid}:${ts}:${idx}:a`, sessionId: sid, ts, role: 'assistant', kind: 'message', text, project: pl.cwd || '' });
        return;
      }
      if (t === 'summary') {
        const text = extractPayloadText(pl);
        if (text) out.push({ agent: ID, sourceId: `${sid}:${ts}:${idx}:s`, sessionId: sid, ts, role: 'assistant', kind: 'summary', text, project: pl.cwd || '' });
        return;
      }
      // 新格式：response_item 内嵌 message
      if (t === 'response_item' && pl.type === 'message') {
        const role = pl.role;
        if (role !== 'user' && role !== 'assistant') return; // developer/system 系统上下文跳过
        const text = extractContentText(pl.content);
        if (!text) return;
        // Codex Desktop 把 system context 当 user role 写入，过滤掉避免污染 board 标题
        if (role === 'user' && isSystemContextMessage(text)) return;
        out.push({
          agent: ID, sourceId: `${sid}:${pl.id || ts}:${idx}`,
          sessionId: sid, ts, role, kind: 'message', text, project: pl.cwd || '',
        });
      }
    } catch { /* skip */ }
  });
  return out;
}

function updateCodexActivity(store, filePath, lines, msgs) {
  const last = msgs[msgs.length - 1];
  const sourceTs = lines.reduce((latest, line) => Math.max(latest, Date.parse(line.timestamp) || 0), 0);
  const info = { agent: ID, project: (last && last.project) || '' };
  if (lines.some(isDefinitiveContinuationLine)) {
    store.confirmCodexContinuation(`${ID}:${sessionIdFromPath(filePath)}`, sourceTs, info);
  } else {
    store.noteCodexActivity(`${ID}:${sessionIdFromPath(filePath)}`, sourceTs, info);
  }
}

// 服务刚重启时，增量 offset 已在文件末尾，不能依赖 watcher 重读最后一个 task_complete。
// 仅复核看板当前仍显示活跃的 Codex 会话尾部，避免文件修改时间漂移漏掉应完成的会话。
function reconcileRecentCompletions(store) {
  const activeRefs = new Set(store.getActive()
    .filter((session) => session.agent === ID)
    .map((session) => session.sessionRef));
  if (!activeRefs.size) return 0;
  let count = 0;
  for (const f of collectFiles(ROOT, isSessionFile)) {
    if (!activeRefs.has(`${ID}:${sessionIdFromPath(f)}`)) continue;
    let stat;
    try { stat = fs.statSync(f); } catch { continue; }
    try {
      const start = Math.max(0, stat.size - 256 * 1024);
      const text = fs.readFileSync(f).subarray(start).toString('utf8');
      const rawLines = text.slice(start > 0 ? text.indexOf('\n') + 1 : 0).split('\n');
      const lines = [];
      for (const raw of rawLines) {
        try { if (raw.trim()) lines.push(JSON.parse(raw)); } catch { /* skip */ }
      }
      if (!lines.length) continue;
      const msgs = parseLines(lines, f);
      for (const m of msgs) { store.ingest(m); count++; }
      updateCodexActivity(store, f, lines, msgs);
    } catch { /* 单个日志读取失败不阻断启动 */ }
  }
  return count;
}

// 探测/安装配置。命令取自 EchoBird 官方安装定义 docs/api/tools/install/codex.json，
// 路径列表取自其 tools/codex/paths.json。
const detect = {
  tier: 'cli',
  identityGuard: {
    description: 'Codex CLI 是 OpenAI 官方的命令行 coding agent',
    notToConfuseWith: ['Claude Code（Anthropic，@anthropic-ai/claude-code）', 'OpenCode（Charm/Anomaly，opencode-ai）', 'GitHub Copilot（VS Code 插件）'],
  },
  requirements: { node: '>=22' },
  probe: {
    kind: 'path',
    win32: [
      '%APPDATA%\\npm\\codex.cmd',
      '%USERPROFILE%\\scoop\\shims\\codex.exe',
      '%USERPROFILE%\\.bun\\bin\\codex.exe',
      '%USERPROFILE%\\.local\\bin\\codex.exe',
      '%LOCALAPPDATA%\\pnpm\\codex.exe',
    ],
    darwin: [
      '/usr/local/bin/codex', '/opt/homebrew/bin/codex', '~/.bun/bin/codex',
      '~/.local/bin/codex', '~/.npm-global/bin/codex', '~/Library/pnpm/codex',
    ],
    linux: [
      '/usr/local/bin/codex', '/usr/bin/codex', '~/.bun/bin/codex',
      '~/.local/bin/codex', '~/.npm-global/bin/codex', '~/.local/share/pnpm/codex',
    ],
  },
  install: {
    methods: [
      { kind: 'npm', pkg: '@openai/codex' },
      { kind: 'script', posix: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh' },
      { kind: 'script', win32: 'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"' },
    ],
    warning: "npm 包名必须精确是 '@openai/codex'，不要单独装 'codex'（是另一个不相关的包）",
  },
  network: {
    testUrls: ['https://registry.npmjs.org/@openai/codex', 'https://github.com/openai/codex'],
    mirrors: { npm: 'https://registry.npmmirror.com' },
    blockedRegions: {},
  },
  verify: { cmd: 'codex --version' },
  afterInstall: {
    tellUser: ['Node.js 版本要求 >=22', 'Windows 上直接用 PowerShell 运行，不要通过 WSL'],
  },
};

module.exports = {
  ID, ROOT, SESSION_INDEX, isSessionFile, parseSessionIndexLines, applySessionIndexTitles, syncSessionTitles, parseLines, completionHoldMsForHistory, isDefinitiveContinuationLine, fileToSessionId: sessionIdFromPath, detect, reconcileRecentCompletions,
  scanAll(store) {
    const files = collectFiles(ROOT, isSessionFile);
    let count = 0;
    for (const f of files) {
      const key = `offset:${ID}:${f}`;
      const offset = Number(store.stmts.getMeta.get(key)?.v || 0);
      const { lines, newOffset } = readAll(f, offset);
      if (lines.length) {
        const msgs = parseLines(lines, f);
        for (const m of msgs) { store.ingest(m); count++; }
        updateCodexActivity(store, f, lines, msgs);
      }
      store.stmts.setMeta.run(key, String(newOffset));
    }
    return count;
  },
  poll(store, changedPaths) {
    let count = 0;
    for (const f of changedPaths.filter(isSessionFile)) {
      const key = `offset:${ID}:${f}`;
      const offset = Number(store.stmts.getMeta.get(key)?.v || 0);
      const { lines, newOffset } = tailRead(f, offset);
      if (lines.length) {
        const msgs = parseLines(lines, f);
        for (const m of msgs) { store.ingest(m); count++; }
        // Codex 会持续写 reasoning / custom_tool 等非消息行；这些同样是会话仍在执行的可靠信号。
        // 因此不能只在 parseLines 产出用户/助手文本时才刷新活跃时间。
        updateCodexActivity(store, f, lines, msgs);
      }
      store.stmts.setMeta.run(key, String(newOffset));
    }
    return count;
  },
};
