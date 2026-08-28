'use strict';
// Marvis (腾讯桌面 AI 助手) 适配器
// 数据源：%AppData%\Tencent\Marvis\User\<uid>\database\data.db (SQLite, WAL 模式)
// 表：conversations(会话元信息+标题) + messages(role/user|assistant|tool, content, message_seq)
const fs = require('fs');
const path = require('path');
const os = require('os');
const { DatabaseSync } = require('node:sqlite');

const ID = 'marvis';
const MARVIS_ROOT = process.platform === 'darwin'
  ? path.join(os.homedir(), 'Library', 'Application Support', 'Tencent', 'Marvis')
  : path.join(os.homedir(), 'AppData', 'Roaming', 'Tencent', 'Marvis');
const ROOT = path.join(MARVIS_ROOT, 'User');

// Marvis 可能同时保留 default_user 和一个或多个真实用户目录。
// 不能只按 mtime 选一个：default_user 可能是空库，但 mtime 反而更新。
function listUserDbs(root = ROOT) {
  if (!fs.existsSync(root)) return [];
  let users;
  try { users = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()); }
  catch { return []; }
  return users
    .map((u) => path.join(root, u.name, 'database', 'data.db'))
    .filter((db) => fs.existsSync(db))
    .sort();
}

// 仅保留给需要“当前用户库”的跳转/诊断场景；数据扫描使用 listUserDbs() 全量读取。
function pickUserDb() {
  const dbs = listUserDbs();
  let best = null;
  let bestMtime = 0;
  for (const db of dbs) {
    // data.db-wal 是当前活跃写入的标志；以它的时间戳判断"当前用户"
    const wal = db + '-wal';
    const shm = db + '-shm';
    const m = Math.max(safeMtime(db), safeMtime(wal), safeMtime(shm));
    if (m > bestMtime) { bestMtime = m; best = db; }
  }
  return best;
}
function safeMtime(p) { try { return fs.statSync(p).mtimeMs; } catch { return 0; } }

function parseTs(s) { if (!s) return 0; const t = Date.parse(s); return Number.isFinite(t) ? t : 0; }

// 提取 content 文本：可能是字符串、{text:'...'}、或 [{type:'text',text:'...'}, ...]
function asText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(asText).filter(Boolean).join('\n').trim();
  }
  if (typeof content === 'object') return content.text || '';
  return '';
}

function parseMessageMetadata(metadata) {
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) return metadata;
  if (typeof metadata !== 'string' || !metadata.trim()) return null;
  try {
    const parsed = JSON.parse(metadata);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

function topologyForMessage(conversationId, metadata) {
  const sessionId = String(conversationId || '').trim();
  const meta = parseMessageMetadata(metadata);
  const subagent = meta && meta.subagent && typeof meta.subagent === 'object' && !Array.isArray(meta.subagent)
    ? meta.subagent : null;
  const rawSubagentId = subagent && subagent.id;
  const subagentId = (typeof rawSubagentId === 'string' || typeof rawSubagentId === 'number')
    ? String(rawSubagentId).trim() : '';
  if (!subagentId) {
    return {
      sessionId,
      sessionRole: 'main',
      topologySource: 'explicit',
      topologyConfidence: 1,
      childDetection: 'verified',
      controlEligibility: 'eligible',
    };
  }
  const title = String(subagent.name || '').trim() || `子代理 ${subagentId}`;
  return {
    sessionId: `${sessionId}:subagent:${subagentId}`,
    sessionRole: 'child',
    parentSessionId: sessionId,
    rootSessionId: sessionId,
    topologySource: 'explicit',
    topologyConfidence: 1,
    childDetection: 'verified',
    controlEligibility: 'blocked',
    title,
  };
}

function childTopologiesForConversation(db, conversationId) {
  const children = new Map();
  try {
    const rows = db.prepare(
      'SELECT metadata FROM messages WHERE conversation_id = ?'
    ).all(conversationId);
    for (const row of rows) {
      const topology = topologyForMessage(conversationId, row.metadata);
      if (topology.sessionRole === 'child') children.set(topology.sessionId, topology);
    }
  } catch (e) {
    console.error(`[${ID}] query child metadata ${conversationId} failed:`, e.message);
  }
  return [...children.values()];
}

// 从 metadata 解析项目/工作目录（不同版本字段不固定，兼容多种命名）
function metaToProject(metaStr) {
  if (!metaStr) return '';
  try {
    const m = JSON.parse(metaStr);
    return m.project || m.cwd || m.workspace || m.workspace_path || m.working_dir || m.work_dir || '';
  } catch { return ''; }
}

// 打开一个用户 db（readOnly 与 writer 并发安全）
function openDb(dbPath) {
  return new DatabaseSync(dbPath, { readOnly: true });
}

// conversations.status 是 Marvis 自己维护的会话状态机（'created'/'in_progress' 未结束，
// 'completed'/'cancelled'/'failed' 是终态）——回合结束的显式信号，之前一直没用上，
// 只能靠「最后消息 10 分钟窗口」兜底判断，导致会话早就结束了看板还要等到 10 分钟才翻状态。
const TERMINAL_STATUSES = new Set(['completed', 'cancelled', 'failed']);

function ingestConversation(db, conv, store) {
  const convId = conv.conversation_id;
  const project = metaToProject(conv.metadata);
  const mainTopology = topologyForMessage(convId, null);
  const childTopologies = childTopologiesForConversation(db, convId);

  // 回合结束显式信号：sourceId 带上 updated_at，同一状态不重复触发；下次真正话恢复对话产生新的
  // updated_at 时会重新触发（哪怕 status 没变化也无妨，setDoneSignal 幂等）。
  if (TERMINAL_STATUSES.has(conv.status)) {
    store.ingest({
      agent: ID, sourceId: `turnend:${convId}:${conv.updated_at}`, sessionId: convId,
      ts: parseTs(conv.updated_at), kind: 'turn_end', ...mainTopology,
    });
    for (const topology of childTopologies) {
      const { title, ...eventTopology } = topology;
      store.ingest({
        agent: ID, sourceId: `turnend:${topology.sessionId}:${conv.updated_at}`,
        sessionId: topology.sessionId, ts: parseTs(conv.updated_at), kind: 'turn_end',
        project, ...eventTopology,
      });
    }
  }

  // 标题：每个会话只发一次（kind=title，不计入消息数/不推高 last_seen）
  const titleKey = `title:${ID}:${convId}`;
  if (conv.title && !store.stmts.getMeta.get(titleKey)?.v) {
    store.ingest({
      agent: ID, sourceId: titleKey, sessionId: convId,
      ts: 0, role: 'system', kind: 'title', text: '',
      title: String(conv.title).trim(), project, ...mainTopology,
    });
    store.stmts.setMeta.run(titleKey, '1');
  }

  // 消息：按 message_seq 增量读（首次 lastSeq=-1，确保包含 seq=0 的首条消息）
  const offsetKey = `offset:topology-v2:${ID}:${convId}`;
  const stored = store.stmts.getMeta.get(offsetKey)?.v;
  const lastSeq = stored == null ? -1 : Number(stored);
  let rows;
  try {
    rows = db.prepare(
      'SELECT message_id, message_seq, role, content, metadata, created_at FROM messages WHERE conversation_id = ? AND message_seq > ? ORDER BY message_seq'
    ).all(convId, lastSeq);
  } catch (e) {
    console.error(`[${ID}] query messages ${convId} failed:`, e.message);
    return 0;
  }
  let n = 0, maxSeq = lastSeq;
  for (const r of rows) {
    const topology = topologyForMessage(convId, r.metadata);
    const { title, ...eventTopology } = topology;
    if (topology.sessionRole === 'child' && title) {
      const childTitleKey = `title:${ID}:${topology.sessionId}`;
      if (!store.stmts.getMeta.get(childTitleKey)?.v) {
        store.ingest({
          agent: ID, sourceId: childTitleKey, sessionId: topology.sessionId,
          ts: 0, role: 'system', kind: 'title', text: '', title, project,
          ...eventTopology,
        });
        store.stmts.setMeta.run(childTitleKey, '1');
      }
    }
    const seq = Number(r.message_seq);
    if (Number.isFinite(seq) && seq > maxSeq) maxSeq = seq;
    const text = asText(r.content);
    // 跳过完全无文本的非 user 消息；user 即便空也保留（用户可能发了空内容/纯附件）
    if (!text && r.role !== 'user') continue;
    const role = r.role === 'tool' ? 'assistant' : (r.role || 'assistant');
    store.ingest({
      agent: ID,
      sourceId: String(r.message_id),
      sessionId: convId,
      ts: parseTs(r.created_at),
      role,
      kind: 'message',
      text,
      project,
      ...eventTopology,
    });
    n++;
  }
  if (maxSeq !== lastSeq) store.stmts.setMeta.run(offsetKey, String(maxSeq));
  return n;
}

function scanFromDb(dbPath, store) {
  let count = 0;
  let db;
  try { db = openDb(dbPath); }
  catch (e) { console.error(`[${ID}] open ${dbPath} failed:`, e.message); return 0; }
  try {
    const convs = db.prepare(
      'SELECT conversation_id, title, status, metadata, created_at, updated_at FROM conversations ORDER BY updated_at DESC'
    ).all();
    for (const c of convs) count += ingestConversation(db, c, store);
  } catch (e) {
    console.error(`[${ID}] scan ${dbPath} failed:`, e.message);
  } finally {
    try { db.close(); } catch {}
  }
  return count;
}

// 从 changedPaths 里识别出本次变更涉及的 user db 路径
function affectedDbs(changedPaths) {
  const out = new Set();
  const re = /[\\/]User[\\/]([^\\/]+)[\\/]database[\\/]/;
  for (const p of changedPaths) {
    const m = (p || '').match(re);
    if (!m) continue;
    const db = path.join(ROOT, m[1], 'database', 'data.db');
    if (fs.existsSync(db)) out.add(db);
  }
  return [...out];
}

// 探测配置：Marvis 不在 EchoBird 支持范围内，没有命令行安装方式，只能手动下载安装
// （官方下载页 2026-08-22 由用户提供：https://marvis.qq.com/）。
// probe 复用上面已有的 ROOT 常量（本机是否有 Marvis 会话数据目录）。
const detect = {
  tier: 'gui',
  identityGuard: { description: 'Marvis（腾讯）桌面 AI 助手', notToConfuseWith: [] },
  requirements: {},
  probe: {
    kind: 'path',
    executable: true,
    // 优先探测实际桌面程序，ROOT 仅作为“安装/数据目录存在”的弱兼容信号。
    win32: [
      '%ProgramFiles(x86)%\\Marvis\\Application\\Marvis.exe',
      '%ProgramFiles(x86)%\\Marvis\\Application\\*\\Marvis.exe',
      '%ProgramFiles%\\Marvis\\Application\\Marvis.exe',
      '%ProgramFiles%\\Marvis\\Application\\*\\Marvis.exe',
      '%ProgramFiles(x86)%\\Tencent\\Marvis\\Application\\Marvis.exe',
      '%ProgramFiles(x86)%\\Tencent\\Marvis\\Application\\*\\Marvis.exe',
      '%ProgramFiles%\\Tencent\\Marvis\\Application\\Marvis.exe',
      '%ProgramFiles%\\Tencent\\Marvis\\Application\\*\\Marvis.exe',
    ],
    darwin: [],
    linux: [],
    executableNames: ['Marvis.exe'],
    registryHints: { windowsDisplayNames: ['Marvis'], windowsPublisher: '腾讯' },
  },
  detectByConfigDir: true,
  configDir: ROOT,
  install: {
    methods: [{ kind: 'download', url: 'https://marvis.qq.com/' }],
    warning: '仅支持手动下载安装，暂无命令行安装方式',
  },
  network: { testUrls: [], mirrors: {}, blockedRegions: {} },
};

module.exports = {
  ID, ROOT, detect, listUserDbs, parseMessageMetadata, topologyForMessage,
  scanAll(store) {
    let count = 0;
    for (const db of listUserDbs()) count += scanFromDb(db, store);
    return count;
  },
  poll(store, changedPaths) {
    // 变更来源可能是 data.db / data.db-wal / data.db-shm 任意一个；只要该用户 db 受影响就重扫
    const dbs = affectedDbs(changedPaths);
    if (!dbs.length) return 0;
    let n = 0;
    for (const d of dbs) n += scanFromDb(d, store);
    return n;
  },
  // SQLite 数据源不存在"单文件即会话"的概念，文件删除不删除会话
  isSessionFile() { return false; },
  // 暴露给 /api/rescan 调用
  pickActiveDb: pickUserDb,
};
