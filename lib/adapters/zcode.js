'use strict';
// ZCode（智谱 AI 编程助手，Claude Code 生态）适配器
// 数据源：~/.zcode/cli/db/db.sqlite (SQLite, WAL 模式)
// 表：
//   session(id=sess_xxx, title, directory=项目路径, time_created/time_updated 毫秒,
//          task_type=interactive|subagent_child, title_source=first_input|...)
//   message(id=msg_xxx, session_id, time_created 毫秒, data JSON 含 role=user|assistant, sequence)
//   part(id, message_id, session_id, time_created, data JSON 含 type=text|reasoning|tool|file|step-*)
// 消息文本在 part 表：只取 type=text / input_text / output_text；reasoning/tool/step-* 不展示
const fs = require('fs');
const path = require('path');
const os = require('os');
const { DatabaseSync } = require('node:sqlite');

const ID = 'zcode';
const ROOT = path.join(os.homedir(), '.zcode', 'cli', 'db');
const DB = path.join(ROOT, 'db.sqlite');

// 只进看板的主会话类型（子代理/后台任务会话跳过，避免刷屏）
const MAIN_TASK_TYPES = new Set(['interactive']);

// ZCode 继承 Claude Code 生态，会把系统注入当 user role 写进消息：
// - TodoWrite 提醒（"The TodoWrite tool hasn't been used recently..."）
// - XML 标签包裹的上下文注入（<environment_context> 等）
// 识别并跳过这些"假 user"消息，避免污染 board 标题/首条指令。
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
  if (text.startsWith("The TodoWrite tool hasn't been used recently")) return true;
  return SYSTEM_CONTEXT_TAGS.some((tag) => text.includes(tag));
}

function openDb() {
  if (!fs.existsSync(DB)) return null;
  try { return new DatabaseSync(DB, { readOnly: true }); } catch (e) { console.error(`[${ID}] open db failed:`, e.message); return null; }
}

// 取 part 的可展示文本；reasoning/tool/file/step-* 等一律跳过
function partText(d) {
  if (!d || typeof d !== 'object') return '';
  const t = d.type;
  if (t === 'text' || t === 'input_text' || t === 'output_text') return String(d.text || '').trim();
  return '';
}

// 单个会话增量入库；返回本批新增条数 n（0 = 无新内容）
function ingestSession(db, sess, store) {
  const sid = sess.id;
  const project = sess.directory || '';

  // 标题：每个会话只发一次（kind=title，不计消息数/不推高 last_seen）
  const titleKey = `title:${ID}:${sid}`;
  if (sess.title && !store.stmts.getMeta.get(titleKey)?.v) {
    store.ingest({
      agent: ID, sourceId: titleKey, sessionId: sid,
      ts: 0, role: 'system', kind: 'title', text: '',
      title: String(sess.title).trim(), project,
    });
    store.stmts.setMeta.run(titleKey, '1');
  }

  // 回合结束显式信号：part.data.type==='step-finish' 且 reason==='stop'（'tool-calls' 表示
  // 还会继续调用工具，非终态）。part 有独立的 sequence 列，用独立 offset 增量扫描——
  // 不能挂在下面 message 的 offset 上：message 行在 turn 开始时就已创建（sequence 早已越过
  // lastSeq），step-finish 是同一 message 下稍后才追加的 part，若和 message 共用 offset，
  // message 早已判定"非新增"时 step-finish 会被永久漏读。
  const partOffsetKey = `offset:${ID}:part:${sid}`;
  const partStored = store.stmts.getMeta.get(partOffsetKey)?.v;
  const partLastSeq = partStored == null ? -1 : Number(partStored);
  try {
    const newParts = db.prepare(
      'SELECT id, time_created, data, sequence FROM part WHERE session_id = ? AND sequence > ? ORDER BY sequence'
    ).all(sid, partLastSeq);
    let maxPartSeq = partLastSeq;
    for (const p of newParts) {
      if (p.sequence != null && p.sequence > maxPartSeq) maxPartSeq = p.sequence;
      try {
        const d = JSON.parse(p.data);
        if (d.type === 'step-finish' && d.reason === 'stop') {
          store.ingest({ agent: ID, sourceId: `turnend:${p.id}`, sessionId: sid, ts: Number(p.time_created) || 0, kind: 'turn_end' });
        }
      } catch { /* skip */ }
    }
    if (maxPartSeq !== partLastSeq) store.stmts.setMeta.run(partOffsetKey, String(maxPartSeq));
  } catch (e) {
    console.error(`[${ID}] query step-finish parts ${sid} failed:`, e.message);
  }

  // 消息：按 sequence 增量读（首次 stored==null → -1，保证 seq=0 的首条也被读到）
  const offsetKey = `offset:${ID}:${sid}`;
  const stored = store.stmts.getMeta.get(offsetKey)?.v;
  const lastSeq = stored == null ? -1 : Number(stored);
  let rows;
  try {
    rows = db.prepare(
      'SELECT id, time_created, data, sequence FROM message WHERE session_id = ? AND sequence > ? ORDER BY sequence'
    ).all(sid, lastSeq);
  } catch (e) {
    console.error(`[${ID}] query messages ${sid} failed:`, e.message);
    return 0;
  }
  if (!rows.length) return 0;

  // 一次性取该会话全部 part，按 message_id 分组（增量查询只按 message 走，part 全量分组开销可控）
  const byMsg = new Map();
  try {
    const parts = db.prepare('SELECT message_id, data FROM part WHERE session_id = ?').all(sid);
    for (const p of parts) {
      try {
        const t = partText(JSON.parse(p.data));
        if (!t) continue;
        if (!byMsg.has(p.message_id)) byMsg.set(p.message_id, []);
        byMsg.get(p.message_id).push(t);
      } catch { /* skip */ }
    }
  } catch (e) { console.error(`[${ID}] query parts ${sid} failed:`, e.message); }

  let n = 0, maxSeq = lastSeq;
  for (const r of rows) {
    let role = 'assistant';
    try {
      const d = JSON.parse(r.data);
      if (d.role === 'user') role = 'user';
    } catch { /* default assistant */ }
    const text = (byMsg.get(r.id) || []).join('\n').trim();
    // 系统注入当 user 写入 → 跳过（否则 futCache 首位取到 TodoWrite 提醒，board 标题错乱）
    if (role === 'user' && isSystemContextMessage(text)) { maxSeq = Math.max(maxSeq, r.sequence); continue; }
    // 无文本的非 user 消息跳过；user 即便空也保留（可能只发了附件）
    if (!text && role !== 'user') { maxSeq = Math.max(maxSeq, r.sequence); continue; }
    store.ingest({
      agent: ID,
      sourceId: String(r.id), // msg_xxx 全局唯一，幂等覆盖天然去重
      sessionId: sid,
      ts: Number(r.time_created) || 0,
      role, kind: 'message', text, project,
    });
    if (r.sequence > maxSeq) maxSeq = r.sequence;
    n++;
  }
  if (maxSeq !== lastSeq) store.stmts.setMeta.run(offsetKey, String(maxSeq));
  return n;
}

function scanFromDb(db, store) {
  let total = 0;
  try {
    const sessions = db.prepare('SELECT id, title, directory, task_type FROM session').all();
    for (const s of sessions) {
      if (!MAIN_TASK_TYPES.has(s.task_type)) continue; // 过滤子代理/后台会话
      total += ingestSession(db, s, store);
    }
  } catch (e) {
    console.error(`[${ID}] scan failed:`, e.message);
  }
  return total;
}

module.exports = {
  ID, ROOT,
  scanAll(store) {
    const db = openDb();
    if (!db) return 0;
    try { return scanFromDb(db, store); } finally { try { db.close(); } catch {} }
  },
  poll(store, changedPaths) {
    // 变更来源可能是 db.sqlite / db.sqlite-wal / db.sqlite-shm 任意一个；命中任一即重扫增量
    const hit = changedPaths.some((p) => {
      const b = path.basename(p || '');
      return b === 'db.sqlite' || b === 'db.sqlite-wal' || b === 'db.sqlite-shm';
    });
    if (!hit) return 0;
    const db = openDb();
    if (!db) return 0;
    let touched = 0;
    try {
      const sessions = db.prepare('SELECT id, title, directory, task_type FROM session').all();
      for (const s of sessions) {
        if (!MAIN_TASK_TYPES.has(s.task_type)) continue;
        const n = ingestSession(db, s, store);
        if (n > 0) {
          touched++;
          // 活跃信号：watch 触发 = ZCode 正在写库 = 正在运行。用当前时间而非消息时间戳，
          // 避免消息写入间隔（思考/工具执行）超过活跃窗口导致状态闪烁。
          store.touchActive(`${ID}:${s.id}`, { agent: ID, project: s.directory || '' }, Date.now());
        }
      }
    } catch (e) { console.error(`[${ID}] poll failed:`, e.message); }
    finally { try { db.close(); } catch {} }
    return touched;
  },
  // SQLite 数据源不存在"单文件即会话"概念，文件删除不删除会话
  isSessionFile() { return false; },
};
