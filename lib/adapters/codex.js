'use strict';
// Codex 适配器：解析 ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
// 兼容两代格式：
//   老 CLI: {timestamp, type:'user_message'|'agent_message'|'summary', payload:{text}}
//   新 Desktop(v0.14x+): {timestamp, type:'response_item', payload:{type:'message', role, content:[{type:'input_text'|'output_text', text}]}}
const path = require('path');
const os = require('os');
const { collectFiles, readAll, tailRead } = require('../watcher');

const ID = 'codex';
const ROOT = path.join(os.homedir(), '.codex', 'sessions');

function isSessionFile(p) { return p.endsWith('.jsonl'); }

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
      // task_complete 是 Codex Desktop 的单轮响应边界，不代表整个会话关闭。
      // 一个长会话会在它之后继续写工具调用和后续回复，不能据此把 session 标成已完成。
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
  ID, ROOT, isSessionFile, parseLines, fileToSessionId: sessionIdFromPath, detect,
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
    for (const f of changedPaths.filter(isSessionFile)) {
      const key = `offset:${ID}:${f}`;
      const offset = Number(store.stmts.getMeta.get(key)?.v || 0);
      const { lines, newOffset } = tailRead(f, offset);
      if (lines.length) {
        const msgs = parseLines(lines, f);
        for (const m of msgs) { store.ingest(m); count++; }
        // Codex 会持续写 reasoning / custom_tool 等非消息行；这些同样是会话仍在执行的可靠信号。
        // 因此不能只在 parseLines 产出用户/助手文本时才刷新活跃时间。
        const last = msgs[msgs.length - 1];
        store.touchActive(`${ID}:${sessionIdFromPath(f)}`, { agent: ID, project: (last && last.project) || '' }, Date.now());
      }
      store.stmts.setMeta.run(key, String(newOffset));
    }
    return count;
  },
};
