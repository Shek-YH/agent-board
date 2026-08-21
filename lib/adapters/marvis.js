'use strict';
// Marvis (腾讯桌面 AI 助手) 适配器
// 数据源：%AppData%\Tencent\Marvis\User\<uid>\database\data.db (SQLite, WAL 模式)
// 表：conversations(会话元信息+标题) + messages(role/user|assistant|tool, content, message_seq)
const fs = require('fs');
const path = require('path');
const os = require('os');
const { DatabaseSync } = require('node:sqlite');

const ID = 'marvis';
const MARVIS_ROOT = path.join(os.homedir(), 'AppData', 'Roaming', 'Tencent', 'Marvis');
const ROOT = path.join(MARVIS_ROOT, 'User');

// 当前登录用户目录（一个 user_id 一个子目录）。自动挑最近活动的那个。
function pickUserDb() {
  if (!fs.existsSync(ROOT)) return null;
  const users = fs.readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory());
  let best = null;
  let bestMtime = 0;
  for (const u of users) {
    const db = path.join(ROOT, u.name, 'database', 'data.db');
    if (!fs.existsSync(db)) continue;
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

function ingestConversation(db, conv, store) {
  const convId = conv.conversation_id;
  const project = metaToProject(conv.metadata);

  // 标题：每个会话只发一次（kind=title，不计入消息数/不推高 last_seen）
  const titleKey = `title:${ID}:${convId}`;
  if (conv.title && !store.stmts.getMeta.get(titleKey)?.v) {
    store.ingest({
      agent: ID, sourceId: titleKey, sessionId: convId,
      ts: 0, role: 'system', kind: 'title', text: '',
      title: String(conv.title).trim(), project,
    });
    store.stmts.setMeta.run(titleKey, '1');
  }

  // 消息：按 message_seq 增量读（首次 lastSeq=-1，确保包含 seq=0 的首条消息）
  const offsetKey = `offset:${ID}:${convId}`;
  const stored = store.stmts.getMeta.get(offsetKey)?.v;
  const lastSeq = stored == null ? -1 : Number(stored);
  let rows;
  try {
    rows = db.prepare(
      'SELECT message_id, message_seq, role, content, created_at FROM messages WHERE conversation_id = ? AND message_seq > ? ORDER BY message_seq'
    ).all(convId, lastSeq);
  } catch (e) {
    console.error(`[${ID}] query messages ${convId} failed:`, e.message);
    return 0;
  }
  let n = 0, maxSeq = lastSeq;
  for (const r of rows) {
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
    });
    if (r.message_seq > maxSeq) maxSeq = r.message_seq;
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
      'SELECT conversation_id, title, metadata, created_at, updated_at FROM conversations ORDER BY updated_at DESC'
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

module.exports = {
  ID, ROOT,
  scanAll(store) {
    const db = pickUserDb();
    if (!db) return 0;
    return scanFromDb(db, store);
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