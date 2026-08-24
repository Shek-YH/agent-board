'use strict';
// 存储层：node:sqlite（Node 22+ 内置，零依赖）
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const os = require('os');
const fs = require('fs');

// 数据目录改为 AppData\Local\AgentBoard：
// 原 ~/.agent-board/agent-board.db 在 Node 22 + 360 环境下会被误判锁定，
// Node 24 + AppData\Local 路径可稳定读写；wf.dll 仍放在 ~/.agent-board。
const DATA_DIR = path.join(os.homedir(), 'AppData', 'Local', 'AgentBoard');
const DB_PATH = path.join(DATA_DIR, 'data.dat');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);

db.exec(`
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  session_id TEXT NOT NULL,
  project TEXT DEFAULT '',
  title TEXT DEFAULT '',
  first_seen INTEGER DEFAULT 0,
  last_seen INTEGER DEFAULT 0,
  msg_count INTEGER DEFAULT 0,
  UNIQUE(agent, session_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT NOT NULL,
  source_id TEXT NOT NULL,
  session_ref TEXT NOT NULL,
  ts INTEGER NOT NULL,
  role TEXT DEFAULT '',
  kind TEXT DEFAULT 'message',
  text TEXT DEFAULT '',
  UNIQUE(agent, source_id)
);
CREATE INDEX IF NOT EXISTS idx_msg_ts ON messages(ts DESC);
CREATE INDEX IF NOT EXISTS idx_msg_session ON messages(session_ref);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS hidden (
  agent TEXT NOT NULL,
  session_id TEXT NOT NULL,
  at INTEGER DEFAULT 0,
  PRIMARY KEY(agent, session_id)
);
`);

const stmts = {
  ensureSession: db.prepare(`
    INSERT INTO sessions (id, agent, session_id, project, title, first_seen, last_seen, msg_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0)
    ON CONFLICT(id) DO UPDATE SET
      project = CASE WHEN excluded.project != '' THEN excluded.project ELSE sessions.project END,
      title = CASE WHEN excluded.title != '' THEN excluded.title ELSE sessions.title END,
      first_seen = CASE WHEN excluded.first_seen > 0
                        THEN MIN(sessions.first_seen, excluded.first_seen)
                        ELSE sessions.first_seen END,
      last_seen = CASE WHEN excluded.last_seen > 0
                       THEN MAX(sessions.last_seen, excluded.last_seen)
                       ELSE sessions.last_seen END
  `),
  bumpSession: db.prepare(`
    UPDATE sessions SET last_seen = MAX(last_seen, ?), msg_count = msg_count + 1 WHERE id = ?
  `),
  touchSession: db.prepare(`
    UPDATE sessions SET last_seen = MAX(last_seen, ?) WHERE id = ?
  `),
  // UPSERT：同 sourceId 冲突时更新内容（修复解析器升级后旧空文本残留）
  insertMsg: db.prepare(`
    INSERT INTO messages (agent, source_id, session_ref, ts, role, kind, text)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent, source_id) DO UPDATE SET
      text = excluded.text,
      role = excluded.role,
      kind = excluded.kind,
      ts = excluded.ts
  `),
  msgExists: db.prepare(`SELECT 1 FROM messages WHERE agent = ? AND source_id = ? LIMIT 1`),
  getMeta: db.prepare(`SELECT v FROM meta WHERE k = ?`),
  setMeta: db.prepare(`INSERT INTO meta (k, v) VALUES (?, ?)
    ON CONFLICT(k) DO UPDATE SET v = excluded.v`),
  getSession: db.prepare(`SELECT * FROM sessions WHERE id = ?`),
  sessionMessages: db.prepare(`
    SELECT id, agent, ts, role, kind, text FROM messages
    WHERE session_ref = ? ORDER BY ts ASC`),
  timeline: db.prepare(`
    SELECT m.id, m.agent, m.ts, m.role, m.kind, m.text, m.session_ref,
           s.project, s.title
    FROM messages m LEFT JOIN sessions s ON s.id = m.session_ref
    WHERE (m.ts < ? OR ? = 0)
      AND (? = '' OR m.agent = ?)
      AND (? = '' OR s.project = ?)
      AND (? = '' OR m.text LIKE '%' || ? || '%')
    ORDER BY m.ts DESC LIMIT ?
  `),
  agents: db.prepare(`
    SELECT agent, COUNT(*) AS cnt FROM messages GROUP BY agent ORDER BY cnt DESC
  `),
  projects: db.prepare(`
    SELECT project, COUNT(*) AS cnt FROM sessions
    WHERE project != '' GROUP BY project ORDER BY cnt DESC
  `),
  stats: db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN ts >= ? THEN 1 ELSE 0 END) AS today
    FROM messages
  `),
  recentSessions: db.prepare(`
    SELECT id, agent, session_id, project, title, last_seen, msg_count FROM sessions
    ORDER BY last_seen DESC LIMIT 200
  `),
  listSessions: db.prepare(`
    SELECT s.id, s.agent, s.session_id, s.project, s.title, s.last_seen, s.first_seen, s.msg_count,
           (SELECT text FROM messages WHERE session_ref = s.id AND role = 'user' AND text != ''
            ORDER BY ts DESC LIMIT 1) AS last_user_text,
           (SELECT text FROM messages WHERE session_ref = s.id AND role = 'user' AND text != ''
            ORDER BY ts ASC LIMIT 1) AS first_user_text
    FROM sessions s
    WHERE (s.last_seen < ? OR ? = 0)
      -- 只保留用户真正参与过的会话（有非空 user 消息），过滤心跳/自动化/纯系统会话
      AND EXISTS (SELECT 1 FROM messages m2
                  WHERE m2.session_ref = s.id AND m2.role = 'user' AND m2.text != '')
      AND (? = '' OR s.agent = ?)
      AND (? = '' OR s.project = ?)
      AND (? = '' OR s.title LIKE '%' || ? || '%'
                      OR s.project LIKE '%' || ? || '%'
                      OR (SELECT text FROM messages WHERE session_ref = s.id AND role = 'user'
                          ORDER BY ts DESC LIMIT 1) LIKE '%' || ? || '%')
      AND NOT EXISTS (SELECT 1 FROM hidden h WHERE h.agent = s.agent AND h.session_id = s.session_id)
    ORDER BY s.last_seen DESC LIMIT ?
  `),
  recentActive: db.prepare(`
    SELECT s.id, s.agent, s.project, s.title, s.last_seen, s.msg_count
    FROM sessions s
    WHERE s.last_seen >= ?
      AND EXISTS (SELECT 1 FROM messages m2
                  WHERE m2.session_ref = s.id AND m2.role = 'user' AND m2.text != '')
      AND NOT EXISTS (SELECT 1 FROM hidden h WHERE h.agent = s.agent AND h.session_id = s.session_id)
    ORDER BY s.last_seen DESC LIMIT 200
  `),
  allMsgCountBySession: db.prepare(`SELECT COUNT(*) AS c FROM messages WHERE session_ref = ?`),
  // 隐藏（黑名单）：隐藏后即便源文件仍在也不显示，可恢复
  hideSession: db.prepare(`INSERT OR IGNORE INTO hidden (agent, session_id, at) VALUES (?, ?, ?)`),
  unhideSession: db.prepare(`DELETE FROM hidden WHERE agent = ? AND session_id = ?`),
  listHidden: db.prepare(`SELECT agent, session_id, at FROM hidden ORDER BY at DESC`),
  deleteSessionMsgs: db.prepare(`DELETE FROM messages WHERE session_ref = ?`),
  deleteSession: db.prepare(`DELETE FROM sessions WHERE id = ?`),
};

// 从 WorkBuddy 类 user 文本中提取用户真正的指令（去掉 system-reminder 等上下文）
function extractUserQuery(text) {
  if (!text) return '';
  // Claude Code 系统占位（中断/命令消息）不应作为"用户指令"
  const t = String(text).trim();
  if (/^\[Request interrupted by user/.test(t)) return '';
  if (/^<command-message>/.test(t)) return '';
  if (/^<system-reminder/.test(t) && !/<user_query>/.test(t)) return '';
  const m = t.match(/<user_query>([\s\S]*?)<\/user_query>/g);
  if (m && m.length) {
    const last = m[m.length - 1].replace(/<\/?user_query>/g, '').trim();
    if (last) return last;
  }
  // 兜底：去掉 HTML 标签后的纯文本
  const cleaned = t
    .replace(/<[^>]+>/g, ' ')
    .replace(/^\s*[\r\n]+/gm, '')
    .trim();
  return cleaned || '';
}

function smartTitle(text) {
  const q = extractUserQuery(text);
  return (q || '').replace(/\s+/g, ' ').slice(0, 40) || '';
}

// 活动会话内存态：ref -> { agent, project, title, lastActivity }
const activeMap = new Map();
const AGENT_META = {
  claude: { name: 'Claude Code', color: '#D97757' },
  codex: { name: 'Codex', color: '#10A37F' },
  workbuddy: { name: 'WorkBuddy', color: '#3B82F6' },
  other: { name: '其他', color: '#888780' },
};
function agentMeta(a) { return AGENT_META[a] || AGENT_META.other; }

function nowMs() { return Date.now(); }

// 事务批量执行（大幅提升批量入库速度）
function tx(fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }
}

// 统一入库入口
function ingest(msg) {
  // msg: { agent, sourceId, sessionId, ts(ms), role, kind, text, project, title }
  const ref = msg.agent + ':' + msg.sessionId;
  const isMeta = (msg.kind === 'heartbeat' || msg.kind === 'title');
  if (isMeta) {
    // 元信息（心跳/标题）：只建会话、更新标题与活跃，不计消息数
    stmts.ensureSession.run(ref, msg.agent, String(msg.sessionId),
      msg.project || '', msg.title || '', msg.ts, msg.ts);
  } else {
    const exists = stmts.msgExists.get(msg.agent, msg.sourceId);
    if (!exists) {
      stmts.ensureSession.run(ref, msg.agent, String(msg.sessionId),
        msg.project || '', msg.title || '', msg.ts, msg.ts);
      stmts.bumpSession.run(msg.ts, ref);
    }
    // 总是 UPSERT：已存在时更新 text/role（修复解析器升级后的空文本残留），不重复计数
    stmts.insertMsg.run(msg.agent, msg.sourceId, ref, msg.ts,
      msg.role || '', msg.kind || 'message', msg.text || '');
  }
  touchActive(ref, { agent: msg.agent, project: msg.project || '', title: msg.title || '' }, msg.ts);
  return ref;
}

function touchActive(ref, info, ts) {
  const cur = activeMap.get(ref);
  const merged = {
    agent: info.agent || (cur && cur.agent) || 'other',
    project: info.project !== undefined ? info.project : (cur && cur.project) || '',
    title: info.title !== undefined ? info.title : (cur && cur.title) || '',
    // ts<=0（如 custom-title 无时间戳）时沿用已有活跃时间，绝不兜底成当前时间
    lastActivity: ts > 0 ? ts : (cur && cur.lastActivity) || 0,
  };
  if (merged.lastActivity > 0) {
    activeMap.set(ref, merged);
    stmts.touchSession.run(merged.lastActivity, ref);
  }
  return merged;
}

function expireActive(withinMs) {
  const cutoff = nowMs() - withinMs;
  for (const [k, v] of activeMap) {
    if (v.lastActivity < cutoff) activeMap.delete(k);
  }
}

function getActive() {
  expireActive(3 * 60 * 1000);
  return [...activeMap.entries()].map(([ref, v]) => ({ sessionRef: ref, ...v }));
}

function getStats() {
  const dayStart = nowMs() - 24 * 3600 * 1000;
  const s = stmts.stats.get(dayStart);
  return { total: s.total, today: s.today, active: getActive().length };
}

function getTimeline({ agent = '', project = '', q = '', cursor = 0, limit = 100 } = {}) {
  return stmts.timeline.all(Number(cursor) || 0, Number(cursor) || 0,
    agent, agent, project, project, q, q, Number(limit) || 100);
}

function getSession(ref) {
  const s = stmts.getSession.get(ref);
  if (!s) return null;
  s.messages = stmts.sessionMessages.all(ref);
  return s;
}

function getSessions({ agent = '', project = '', q = '', cursor = 0, limit = 100 } = {}) {
  const c = Number(cursor) || 0;
  const l = Number(limit) || 100;
  const qs = q || '';
  const rows = stmts.listSessions.all(c, c, agent, agent, project, project, qs, qs, qs, qs, l);
  const now = nowMs();
  return rows.map((r) => {
    const a = activeMap.get(r.id);
    const lastQuery = extractUserQuery(r.last_user_text);
    // 标题兜底：无官方标题时用首条用户指令生成可读标题
    const title = r.title || smartTitle(r.first_user_text) || (r.session_id || '').slice(0, 12);
    return {
      ...r,
      title,
      last_user_text: lastQuery.slice(0, 4000),
      status: a && (now - a.lastActivity < 3 * 60 * 1000) ? 'active' : 'done',
    };
  });
}

// 按统计时长返回"最近活跃"会话（过滤无用户消息的自动化会话）
// range: 'day'(今天0点起) | '24h' | 'week' | 'month'
function getRecentActive(range = 'day') {
  let cutoff;
  const d = new Date();
  if (range === '24h') cutoff = nowMs() - 24 * 3600 * 1000;
  else if (range === 'week') cutoff = nowMs() - 7 * 24 * 3600 * 1000;
  else if (range === 'month') cutoff = nowMs() - 30 * 24 * 3600 * 1000;
  else { d.setHours(0, 0, 0, 0); cutoff = d.getTime(); } // day
  const rows = stmts.recentActive.all(cutoff);
  const now = nowMs();
  return rows.map((r) => ({
    sessionRef: r.id,
    agent: r.agent,
    project: r.project,
    title: r.title || smartTitle(''),
    lastActivity: r.last_seen,
    msgCount: r.msg_count,
    live: now - r.last_seen < 3 * 60 * 1000,
  }));
}

// ---------- 隐藏 / 删除会话 ----------
function hideSession(agent, sessionId) { stmts.hideSession.run(agent, String(sessionId), Date.now()); }
function unhideSession(agent, sessionId) { stmts.unhideSession.run(agent, String(sessionId)); }
function listHidden() { return stmts.listHidden.all(); }
// 源文件被删除时，按 agent+sessionId 删除会话及其消息（用于 watch 删除事件同步）
function deleteSessionByRef(agent, sessionId) {
  const ref = `${agent}:${sessionId}`;
  stmts.deleteSessionMsgs.run(ref);
  return stmts.deleteSession.run(ref).changes;
}

module.exports = {
  ingest, touchActive, getActive, getRecentActive, getStats, getTimeline, getSession, getSessions, tx,
  agentMeta, AGENT_META, db, stmts, nowMs, extractUserQuery, smartTitle,
  hideSession, unhideSession, listHidden, deleteSessionByRef,
};
