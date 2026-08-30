'use strict';
// WorkBuddy 适配器：解析 ~/.workbuddy/projects/<escaped-path>/<uuid>.jsonl
// + ~/.workbuddy/sessions/*.json 心跳文件（实时活跃信号）
const path = require('path');
const fs = require('fs');
const { collectFiles, readAll, tailRead } = require('../watcher');
const { createStatusReader } = require('../workbuddy-status');
const { SOURCE_PATHS } = require('../source-paths');

const ID = 'workbuddy';
const ROOT = SOURCE_PATHS.workbuddy;
const HEARTBEAT_DIR = SOURCE_PATHS.workbuddyHeartbeat;
const statusReader = createStatusReader({ dbPath: SOURCE_PATHS.workbuddyDb });

// 心跳「持续更新」检测（模块级内存，重启后重新建立基准，安全）：
// - CLI host 会话（interactive-*）的心跳持续前进（每 ~30s 更新）→ 心跳停 = 进程退出 = 提前完成
// - 桌面对话会话的心跳是一次性的（仅启动时写一次，之后不再更新）→ 不能用来判完成
// lastHb: ref -> 上次观察到的心跳值；hbTracked: 已确认「心跳持续更新」的 ref 集合
const lastHb = new Map();
const hbTracked = new Set();
const HEARTBEAT_STALE_MS = 90 * 1000;

function getHeartbeatTransition({ previousHeartbeat, heartbeat, now, tracked }) {
  if (previousHeartbeat === undefined) return 'baseline';
  const fresh = now - heartbeat < HEARTBEAT_STALE_MS;
  if (heartbeat > previousHeartbeat && fresh) return 'active';
  if (tracked && !fresh) return 'stopped';
  return 'unchanged';
}

// 桌面会话「停顿检测」参数（见 checkDesktopIdle）：
// WorkBuddy 桌面会话（UUID sessionId）的心跳一次性写入、无法用「心跳停止」提前完成，
// 也没有 Marvis 那种 conversations.status 终态字段可读（转录格式里翻遍所有 type 也没有
// 「本轮结束」事件，2026-08-22 全量核实过）；jsonl 只写「已完成」的消息（status=completed，
// 无流式中间态）→「文件停止写入 + 最后一条真实消息是 assistant」是唯一能用的近似信号。
// 阈值原为 300s+40s（实测一轮回复内全行间隙几乎都 < 130s，偶发 ~2.5 分钟，300s 留了约 2 倍余量）；
// 2026-08-22 应用户要求缩到 60s+20s（与 codex 的 idle-check 一致），同日再次应用户要求缩到 40s+20s
// 换取更快的状态更新——代价：某次思考间隙一旦超过该阈值，会被提前误判「已完成」，等下一个工具调用
// 写入文件时才会自愈跳回「进行中」（单调纠正，不是来回闪烁，但用户会看到一次误判）。如果误判明显
// 变多，优先考虑调回 60s/300s 而不是继续调低。
const DESKTOP_IDLE_MS = 40 * 1000;   // 文件静止超过该时长 → 进入「疑似停笔」
const DESKTOP_FRESH_MS = 30 * 1000;   // 文件 30s 内有写入 → agent 正在跑
const DESKTOP_DEBOUNCE_MS = 20 * 1000; // 20s 定时器周期命中即判（60s 静止本身足够长，不再要求连续 2 次）
// 每 ref 首次「疑似停笔」的时间（用于 debounce）；内存态，重启后重建（旧会话自然落入 10 分钟窗口兜底）
const deskIdleSince = new Map();

function isSessionFile(p) { return p.endsWith('.jsonl'); }

function fileOffsetKey(filePath) {
  return `offset:topology-v2:${ID}:${filePath}`;
}
function isHeartbeat(p) { return p.endsWith('.json') && !p.includes('settings') && !p.includes('sessions.json'); }

const CHILD_FILE_RE = /[\\/]([^\\/]+)[\\/]subagents[\\/]agent-([^\\/]+)\.jsonl$/i;
const sessionIdsByFile = new Map();

function inlineSessionId(source) {
  const rows = Array.isArray(source) ? source : [source];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    if (typeof row.sessionId !== 'string') continue;
    const sessionId = row.sessionId.trim();
    if (sessionId) return sessionId;
  }
  return '';
}

function workbuddyFileTopology(filePath, source = {}) {
  const match = String(filePath || '').match(CHILD_FILE_RE);
  const sessionId = inlineSessionId(source);
  if (match && sessionId) sessionIdsByFile.set(String(filePath), sessionId);
  if (!match) {
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
  const parentSessionId = match[1].trim();
  const agentId = match[2].trim();
  return {
    sessionId: sessionId || `${parentSessionId}:subagent:${agentId}`,
    sessionRole: 'child',
    parentSessionId,
    rootSessionId: parentSessionId,
    topologySource: sessionId ? 'explicit' : 'structural',
    topologyConfidence: 1,
    childDetection: 'verified',
    controlEligibility: 'blocked',
  };
}

function extractText(content) {
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

function parseLines(lines, filePath = '') {
  const out = [];
  for (const line of lines) {
    try {
      const topology = workbuddyFileTopology(filePath, line);
      if (line.type === 'ai-title' && topology.sessionId) {
        out.push({
          agent: ID, sourceId: `title:${topology.sessionId}`,
          sessionId: topology.sessionId, ts: Number(line.timestamp) || 0,
          role: 'system', kind: 'title', text: '', title: String(line.aiTitle || '').trim(),
          project: line.cwd || '',
          ...topology,
        });
        continue;
      }
      if (line.type !== 'message' || !topology.sessionId) continue;
      const text = extractText(line.content);
      if (!text) continue;
      const ts = Number(line.timestamp) || Date.now();
      const sourceId = line.id || (topology.sessionId + ':' + line.timestamp + ':' + Math.random());
      out.push({
        agent: ID,
        sourceId,
        sessionId: topology.sessionId,
        ts,
        role: line.role === 'user' ? 'user' : 'assistant',
        kind: 'message',
        text,
        project: line.cwd || '',
        ...topology,
      });
    } catch { /* skip */ }
  }
  return out;
}

// WorkBuddy 自带 SQLite 状态是会话级 active/终态的更强信号；数据库不可读时保持 JSONL/心跳兜底。
function scanSessionStatuses(store, reader = statusReader) {
  const statuses = reader.read();
  for (const status of statuses.values()) {
    store.noteExternalStatus(`${ID}:${status.sessionId}`, status);
  }
  return statuses.size;
}

// 心跳扫描：读取 ~/.workbuddy/sessions/*.json，报告每个活动会话
function scanHeartbeats(store) {
  const out = [];
  scanSessionStatuses(store);
  if (!fs.existsSync(HEARTBEAT_DIR)) return out;
  let entries;
  try { entries = fs.readdirSync(HEARTBEAT_DIR); } catch { return out; }
  const now = Date.now();
  for (const name of entries) {
    const p = path.join(HEARTBEAT_DIR, name);
    if (!name.endsWith('.json')) continue;
    try {
      const d = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (!d.sessionId) continue;
      const ref = `${ID}:${d.sessionId}`;
      // 手动标记为已完成的会话：跳过心跳跟踪（等同「关闭心跳」）——不再 ingest 心跳建会话/顶活跃
      if (store.isManuallyDone(ref)) continue;
      const hb = Number(d.lastHeartbeat) || 0;
      const now = Date.now();
      // 心跳停止信号（仅对「持续更新」的会话生效，见模块顶部注释）：
      // 先观察一次建立基准 → 心跳前进且新鲜 = CLI host 在跑（记入 hbTracked）
      // → 已跟踪心跳超过新鲜窗口仍未更新 = 进程可能退出 → 提前结束「进行中」
      const prevHb = lastHb.get(ref);
      const transition = getHeartbeatTransition({
        previousHeartbeat: prevHb,
        heartbeat: hb,
        now,
        tracked: hbTracked.has(ref),
      });
      if (transition === 'baseline') {
        lastHb.set(ref, hb); // 首次观察：只记录基准，不判定
      } else if (transition === 'active') {
        hbTracked.add(ref);
        store.setAgentActive(ref, true, now);
        lastHb.set(ref, hb);
      } else {
        if (transition === 'stopped') store.setAgentActive(ref, false, now); // 心跳已过期 → 提前完成
        lastHb.set(ref, hb);
      }
      // 心跳在 5 分钟内视为活跃
      const active = now - hb < 5 * 60 * 1000;
      store.noteHeartbeat(ref, active, now);
      const info = {
        agent: ID,
        sessionId: d.sessionId,
        project: d.cwd || '',
        title: '',
        lastActivity: hb || now,
        active,
      };
      out.push(info);
      if (active) {
        // 注意：不再 touchActive——「进行中/活跃」判定已由 lastMsgAt（真实消息 ts）权威接管。
        // 心跳若仍用 now 顶 lastActivity，会把关掉 UI 但进程保活的会话永久标成「进行中」。
        // 这里只确保会话存在（无消息也可见），状态由真实消息决定。
        store.ingest({
          agent: ID, sourceId: `hb:${d.sessionId}`, sessionId: d.sessionId,
          ts: hb, role: 'system', kind: 'heartbeat', text: '',
          project: d.cwd || '',
        });
      }
    } catch { /* skip */ }
  }
  return out;
}

function readFirstSessionId(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const chunkSize = 16 * 1024;
    const maxBytes = 1024 * 1024;
    let offset = 0;
    let carry = '';
    while (offset < maxBytes) {
      const size = Math.min(chunkSize, maxBytes - offset);
      const buffer = Buffer.allocUnsafe(size);
      const read = fs.readSync(fd, buffer, 0, size, offset);
      if (!read) break;
      offset += read;
      carry += buffer.toString('utf8', 0, read);
      const rows = carry.split(/\r?\n/);
      carry = rows.pop() || '';
      for (const raw of rows) {
        if (!raw.trim()) continue;
        try {
          const row = JSON.parse(raw);
          const sessionId = inlineSessionId(row);
          if (sessionId) return sessionId;
        } catch { /* skip malformed JSONL rows */ }
      }
    }
    if (carry.trim()) {
      try { return inlineSessionId(JSON.parse(carry)); } catch { /* skip malformed JSONL row */ }
    }
  } catch { /* file may be concurrently created or removed */ }
  finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
  return '';
}

function fileToSessionId(file) {
  const filePath = String(file || '');
  const cached = sessionIdsByFile.get(filePath);
  if (cached) return cached;
  const fallback = path.basename(filePath).replace(/\.jsonl$/, '');
  if (!CHILD_FILE_RE.test(filePath)) return fallback;
  const sessionId = readFirstSessionId(filePath);
  if (sessionId) sessionIdsByFile.set(filePath, sessionId);
  return workbuddyFileTopology(filePath, { sessionId }).sessionId || fallback;
}

// 桌面会话「停顿检测」（server.js 每 20s 调用）：
// 判定「agent 是否已停笔」→ 提前结束「进行中」，不必等满 10 分钟消息窗口。
//   - 文件 mtime 距今 < 30s                → agent 正在写 → setAgentActive(ref, true)（清除停止标记）
//   - 最后真实消息是 user（新指令已到、agent 未回复/回复中）：
//       文件在写 → 清除停止标记（agent 已恢复）；否则不判（10 分钟窗口兜底）
//   - mtime 距今 > 40s 且最后真实消息是 assistant 且文件末行是 message：
//       连续 2 次命中（20s debounce）→ setAgentActive(ref, false) → 立即退出「进行中」
//   - 其余（30~40s 中间地带 / 末行是 function_call|reasoning|ai-title 等 = agent 工作中）→ 不动
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
      // 最后真实消息是 user（agent 尚未回复）：文件在写 = agent 已恢复（可能是上一轮被误判停止后 resume）
      if (idle < DESKTOP_FRESH_MS) store.setAgentActive(ref, true, now);
      deskIdleSince.delete(ref);
      continue;
    }

    if (idle < DESKTOP_FRESH_MS) {
      // 正在写 = 在跑：清除停止标记（可能刚 resume）
      store.setAgentActive(ref, true, now);
      deskIdleSince.delete(ref);
    } else if (idle > DESKTOP_IDLE_MS) {
      // 安全边界：只有文件末行是 message（= 一轮回复以完整消息收尾）才判停笔；
      // 末行是 function_call / function_call_result / reasoning / ai-title / file-history-snapshot
      // 都可能是 agent 工作中（长工具执行 / 思考 / 标题生成），一律交给 10 分钟窗口兜底，不提前判。
      if (getLastLineType(f) !== 'message') { deskIdleSince.delete(ref); continue; }
      const first = deskIdleSince.get(ref) || now;
      deskIdleSince.set(ref, first);
      // debounce：连续 2 次（≥40s）都疑似停笔才真正判停，避免单次 stat 抖动误判
      if (now - first >= DESKTOP_DEBOUNCE_MS) store.setAgentActive(ref, false, now);
    } else {
      deskIdleSince.delete(ref); // 30~240s 中间地带：可能只是思考间隙，重置
    }
  }
}

// 读文件尾部最后一行，返回其 type。读最后 64KB 足够覆盖绝大多数行；末行超长（巨消息）解析失败
// 时返回 null（此时按「非 message」处理，不提前判停，行为保守安全）。
function getLastLineType(f) {
  let fd = null;
  try {
    fd = fs.openSync(f, 'r');
    const size = fs.fstatSync(fd).size;
    if (size <= 0) return null;
    const buf = Buffer.alloc(Math.min(size, 64 * 1024));
    fs.readSync(fd, buf, 0, buf.length, Math.max(0, size - buf.length));
    const text = buf.toString('utf8');
    // jsonl 每行以 \n 结尾：先去掉尾部换行，再取最后一个 '\n' 之后的内容才是真正的「最后一行」
    const tail = text.endsWith('\n') ? text.slice(0, -1) : text;
    const idx = tail.lastIndexOf('\n');
    const lastLine = (idx >= 0 ? tail.slice(idx + 1) : tail).trim();
    if (!lastLine) return null;
    const o = JSON.parse(lastLine);
    return o && typeof o.type === 'string' ? o.type : null;
  } catch { return null; }
  finally { if (fd) { try { fs.closeSync(fd); } catch { /* ignore */ } } }
}

// 探测/安装配置。命令取自 EchoBird 官方安装定义 docs/api/tools/install/workbuddy.json，
// 路径与注册表匹配取自其 tools/workbuddy/paths.json。
const detect = {
  tier: 'gui',
  identityGuard: {
    description: 'WorkBuddy 是腾讯 CodeBuddy 的"办公版"桌面 Agent',
    notToConfuseWith: ['CodeBuddy 编程 IDE（配置目录是 ~/.codebuddy，完全分开）'],
  },
  requirements: {},
  probe: {
    kind: 'registry',
    executable: true,
    win32: ['%LOCALAPPDATA%\\Programs\\WorkBuddy\\WorkBuddy.exe'],
    darwin: ['/Applications/WorkBuddy.app/Contents/MacOS/WorkBuddy'],
    linux: [],
    executableNames: ['WorkBuddy.exe'],
    registryHints: { displayNamePrefixes: ['WorkBuddy'] },
  },
  install: {
    methods: [
      { kind: 'download', url: 'https://www.workbuddy.cn/work/#download-section' },
    ],
    warning: '请在 WorkBuddy 官方页面完成安装；Agent Board 不会执行第三方安装命令',
  },
  network: { testUrls: ['https://www.workbuddy.cn'], mirrors: {}, blockedRegions: {} },
  afterInstall: {
    tellUser: ['优先用 winget 静默安装；winget 不可用时会打开下载页，需要自己点完安装向导'],
  },
};

module.exports = {
  ID, ROOT, isSessionFile, parseLines, workbuddyFileTopology, scanHeartbeats, scanSessionStatuses, checkDesktopIdle, fileToSessionId, fileOffsetKey, detect,
  getHeartbeatTransition,
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
    scanHeartbeats(store);
    return count;
  },
  poll(store, changedPaths) {
    let count = 0;
    for (const f of changedPaths) {
      if (isSessionFile(f)) {
        const key = fileOffsetKey(f);
        const offset = Number(store.stmts.getMeta.get(key)?.v || 0);
        const { lines, newOffset } = tailRead(f, offset);
      if (lines.length) {
        const msgs = parseLines(lines, f);
        for (const m of msgs) { store.ingest(m); count++; }
        // 活跃判定由 ingest → lastMsgAt（真实消息 ts）权威接管，无需再 touchActive
      }
        store.stmts.setMeta.run(key, String(newOffset));
      } else if (f.startsWith(HEARTBEAT_DIR) && f.endsWith('.json')) {
        scanHeartbeats(store);
      }
    }
    return count;
  },
};
