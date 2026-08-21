'use strict';
// 存储层：JSON 快照 + 内存索引
// 原 SQLite 方案在 Node 22 + 360 环境下会被误判锁定，
// 改用 JSON 文件持久化，运行时全量加载到内存，避免数据库文件被安全软件拦截。
const fs = require('fs');
const path = require('path');
const os = require('os');

const DATA_DIR = path.join(os.homedir(), 'AppData', 'Local', 'AgentBoard');
const DATA_PATH = path.join(DATA_DIR, 'data.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// 内存数据结构
const sessions = new Map();   // id -> session
const messages = new Map();   // "agent:source_id" -> message
const meta = new Map();       // k -> v
const hidden = new Map();     // "agent:session_id" -> { agent, session_id, at }
const activeMap = new Map();  // ref -> { agent, project, title, lastActivity }
const futCache = new Map();   // ref -> { text, ts } 每个会话最早的用户消息（避免 O(N*M) 遍历）
const userMsgFlag = new Map(); // ref -> true  会话内存在真实用户指令（过滤系统注入后仍有内容）

let saveTimer = null;
const SAVE_DELAY_MS = 800;

function load() {
  if (!fs.existsSync(DATA_PATH)) return;
  try {
    const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));
    sessions.clear(); messages.clear(); meta.clear(); hidden.clear(); futCache.clear(); userMsgFlag.clear();
    for (const s of data.sessions || []) {
      s.msg_count = 0;
      sessions.set(s.id, s);
    }
    for (const m of data.messages || []) {
      messages.set(`${m.agent}:${m.source_id}`, m);
      const s = sessions.get(m.session_ref);
      if (s) s.msg_count = (s.msg_count || 0) + 1;
      if (m.role === 'user' && m.text) {
        const cur = futCache.get(m.session_ref);
        if (!cur || (m.ts || 0) < cur.ts) futCache.set(m.session_ref, { text: m.text, ts: m.ts || 0 });
        if (extractUserQuery(m.text)) userMsgFlag.set(m.session_ref, true);
      }
    }
    for (const kv of data.meta || []) meta.set(kv.k, kv.v);
    for (const h of data.hidden || []) hidden.set(`${h.agent}:${h.session_id}`, h);
  } catch (e) {
    console.error('[store] load failed:', e.message);
  }
}

function save() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  const data = {
    sessions: [...sessions.values()],
    messages: [...messages.values()],
    meta: [...meta.entries()].map(([k, v]) => ({ k, v })),
    hidden: [...hidden.values()],
  };
  const json = JSON.stringify(data);
  // 首选：写临时文件 + 原子重命名（正常环境最安全，崩溃不留半截文件）
  const tmp = DATA_PATH + '.tmp';
  try {
    fs.writeFileSync(tmp, json, 'utf-8');
    fs.renameSync(tmp, DATA_PATH);
    return;
  } catch (e) { /* 落到下方原地覆写 */ }
  // 回退：临时文件/重命名被安全软件临时锁定（360 等只拦删除重命名，不拦写入）→ 原地覆写
  try {
    fs.writeFileSync(DATA_PATH, json, 'utf-8');
  } catch (e2) {
    console.error('[store] save failed:', e2.message);
  }
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(save, SAVE_DELAY_MS);
}

function nowMs() { return Date.now(); }

function extractUserQuery(text) {
  if (!text) return '';
  const t = String(text).trim();
  if (/^\[Request interrupted by user/.test(t)) return '';
  if (/^<command-message>/.test(t)) return '';
  if (/^<system-reminder/.test(t) && !/<user_query>/.test(t)) return '';
  const m = t.match(/<user_query>([\s\S]*?)<\/user_query>/g);
  if (m && m.length) {
    const last = m[m.length - 1].replace(/<\/?user_query>/g, '').trim();
    if (last) return last;
  }
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

function userQueryForSession(ref) {
  const c = futCache.get(ref);
  return c ? extractUserQuery(c.text || '') : '';
}

// 统一入库入口
function ingest(msg) {
  const ref = msg.agent + ':' + msg.sessionId;
  const isMeta = (msg.kind === 'heartbeat' || msg.kind === 'title');
  let s = sessions.get(ref);
  if (!s) {
    s = {
      id: ref, agent: msg.agent, session_id: String(msg.sessionId),
      project: msg.project || '', title: msg.title || '',
      first_seen: msg.ts || 0, last_seen: msg.ts || 0, msg_count: 0,
    };
    sessions.set(ref, s);
  } else {
    if (msg.project) s.project = msg.project;
    if (msg.title) s.title = msg.title;
    if (msg.ts > 0) {
      if (!s.first_seen || msg.ts < s.first_seen) s.first_seen = msg.ts;
      if (msg.ts > s.last_seen) s.last_seen = msg.ts;
    }
  }

  if (!isMeta) {
    const key = msg.agent + ':' + msg.sourceId;
    const existed = messages.has(key);
    messages.set(key, {
      agent: msg.agent, source_id: msg.sourceId, session_ref: ref,
      ts: msg.ts || 0, role: msg.role || '', kind: msg.kind || 'message', text: msg.text || '',
    });
    if (!existed) {
      s.msg_count = (s.msg_count || 0) + 1;
      if (msg.ts > s.last_seen) s.last_seen = msg.ts;
    }
    if (msg.role === 'user' && msg.text) {
      const cur = futCache.get(ref);
      if (!cur || (msg.ts || 0) < cur.ts) futCache.set(ref, { text: msg.text, ts: msg.ts || 0 });
      if (extractUserQuery(msg.text)) userMsgFlag.set(ref, true);
    }
  }

  touchActive(ref, { agent: msg.agent, project: msg.project || '', title: msg.title || '' }, msg.ts);
  scheduleSave();
  return ref;
}

function touchActive(ref, info, ts) {
  const cur = activeMap.get(ref);
  // lastActivity 只前进不后退（取 max）：消息 ingest 会用历史时间戳调 touchActive，
  // 若直接覆盖会把刚用 Date.now() 设置的活跃时间打回旧值 → 周期性状态闪烁。
  const curLast = (cur && cur.lastActivity) || 0;
  const merged = {
    agent: info.agent || (cur && cur.agent) || 'other',
    project: info.project !== undefined ? info.project : (cur && cur.project) || '',
    title: info.title !== undefined ? info.title : (cur && cur.title) || '',
    lastActivity: Math.max(ts > 0 ? ts : 0, curLast),
  };
  if (merged.lastActivity > 0) {
    activeMap.set(ref, merged);
    const s = sessions.get(ref);
    if (s && merged.lastActivity > s.last_seen) s.last_seen = merged.lastActivity;
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
  // 只过滤返回活跃项，不真正删除 activeMap（避免与心跳轮询竞态导致状态闪烁）
  const cutoff = nowMs() - 10 * 60 * 1000;
  return [...activeMap.entries()]
    .filter(([, v]) => v.lastActivity >= cutoff)
    .map(([sessionRef, v]) => ({ sessionRef, ...v }));
}

function getStats() {
  const dayStart = nowMs() - 24 * 3600 * 1000;
  let today = 0;
  for (const m of messages.values()) if (m.ts >= dayStart) today++;
  return { total: messages.size, today, active: getActive().length };
}

function getTimeline({ agent = '', project = '', q = '', cursor = 0, limit = 100 } = {}) {
  const lc = (q || '').toLowerCase();
  let list = [];
  for (const m of messages.values()) {
    const s = sessions.get(m.session_ref);
    if (!s) continue;
    if (agent && s.agent !== agent) continue;
    if (project && s.project !== project) continue;
    if (lc && !(m.text || '').toLowerCase().includes(lc)) continue;
    list.push({ ...m, sessionRef: m.session_ref });
  }
  list.sort((a, b) => b.ts - a.ts);
  const idx = list.findIndex(m => m.ts < cursor);
  const start = idx >= 0 ? idx : 0;
  return list.slice(start, start + limit);
}

function getSession(ref) {
  const s = sessions.get(ref);
  if (!s) return null;
  const msgs = [...messages.values()]
    .filter(m => m.session_ref === ref)
    .sort((a, b) => a.ts - b.ts);
  return { ...s, messages: msgs };
}

function getSessions({ agent = '', project = '', q = '', cursor = 0, limit = 100, onlyUser = false, since = 0 } = {}) {
  const c = Number(cursor) || 0;
  const l = Number(limit) || 100;
  const qs = (q || '').toLowerCase();
  let list = [...sessions.values()]
    .filter(s => !hidden.has(s.id))
    .sort((a, b) => b.last_seen - a.last_seen);
  if (agent) list = list.filter(s => s.agent === agent);
  if (project) list = list.filter(s => s.project === project);
  if (onlyUser) list = list.filter(s => userMsgFlag.has(s.id));
  if (since > 0) list = list.filter(s => s.last_seen >= since);
  if (qs) {
    list = list.filter(s => {
      const hay = ((s.title || '') + ' ' + (s.project || '') + ' ' + userQueryForSession(s.id)).toLowerCase();
      return hay.includes(qs);
    });
  }
  const idx = list.findIndex(s => s.last_seen < c);
  const start = idx >= 0 ? idx : 0;
  const now = nowMs();
  return list.slice(start, start + l).map(s => ({
    ...s,
    title: s.title || smartTitle(userQueryForSession(s.id)) || s.session_id.slice(0, 12),
    status: (activeMap.get(s.id)?.lastActivity || 0) > now - 10 * 60 * 1000 ? 'active' : 'done',
    last_user_text: userQueryForSession(s.id).slice(0, 4000),
    has_user: !!userMsgFlag.get(s.id),
  }));
}

function getRecentActive(range = 'day') {
  let cutoff;
  const d = new Date();
  if (range === '24h') cutoff = nowMs() - 24 * 3600 * 1000;
  else if (range === 'week') cutoff = nowMs() - 7 * 24 * 3600 * 1000;
  else if (range === 'month') cutoff = nowMs() - 30 * 24 * 3600 * 1000;
  else { d.setHours(0, 0, 0, 0); cutoff = d.getTime(); }
  const now = nowMs();
  return [...sessions.values()]
    .filter(s => s.last_seen >= cutoff && !hidden.has(s.id))
    .sort((a, b) => b.last_seen - a.last_seen)
    .map(s => ({
      sessionRef: s.id,
      agent: s.agent,
      project: s.project || '',
      title: s.title || smartTitle(userQueryForSession(s.id)),
      lastActivity: s.last_seen,
      msgCount: s.msg_count || 0,
      live: now - s.last_seen < 10 * 60 * 1000,
      has_user: !!userMsgFlag.get(s.id),
    }));
}

function hideSession(agent, sessionId) {
  hidden.set(agent + ':' + sessionId, { agent, session_id: sessionId, at: Date.now() });
  scheduleSave();
}
function unhideSession(agent, sessionId) {
  hidden.delete(agent + ':' + sessionId);
  scheduleSave();
}
function listHidden() { return [...hidden.values()]; }
function deleteSessionByRef(agent, sessionId) {
  const ref = agent + ':' + sessionId;
  sessions.delete(ref);
  for (const [k, m] of messages) if (m.session_ref === ref) messages.delete(k);
  hidden.delete(ref);
  futCache.delete(ref);
  userMsgFlag.delete(ref);
  scheduleSave();
  return 1;
}

// rescan / 管理用的高级 API
function clearAll() {
  sessions.clear(); messages.clear(); meta.clear(); hidden.clear(); futCache.clear(); userMsgFlag.clear();
  scheduleSave();
}
function clearOffsets() {
  for (const k of meta.keys()) if (k.startsWith('offset:')) meta.delete(k);
  scheduleSave();
}
function resetAgent(agent) {
  for (const [k, s] of sessions) if (s.agent === agent) sessions.delete(k);
  for (const [k, m] of messages) if (m.agent === agent) messages.delete(k);
  for (const [k, h] of hidden) if (h.agent === agent) hidden.delete(k);
  for (const [k] of futCache) if (k.startsWith(agent + ':')) futCache.delete(k);
  for (const [k] of userMsgFlag) if (k.startsWith(agent + ':')) userMsgFlag.delete(k);
  scheduleSave();
}
function repairSessionTimestamps() {
  for (const s of sessions.values()) {
    let min = 0, max = 0, count = 0;
    for (const m of messages.values()) {
      if (m.session_ref !== s.id || m.ts <= 0) continue;
      count++;
      if (!min || m.ts < min) min = m.ts;
      if (m.ts > max) max = m.ts;
    }
    s.msg_count = count;
    if (min) s.first_seen = min;
    if (max) s.last_seen = max;
  }
  scheduleSave();
}

// 兼容 server.js 直接访问 stmts / db 的代码
const stmts = {
  getMeta: { get: (k) => meta.has(k) ? { v: meta.get(k) } : undefined },
  setMeta: { run: (k, v) => { meta.set(k, v); scheduleSave(); } },
  agents: { all: () => {
    const counts = {};
    for (const s of sessions.values()) if (!hidden.has(s.id)) counts[s.agent] = (counts[s.agent] || 0) + 1;
    return Object.entries(counts).map(([agent, count]) => ({ agent, count, cnt: count }));
  }},
  projects: { all: () => {
    const counts = {};
    for (const s of sessions.values()) if (s.project && !hidden.has(s.id)) counts[s.project] = (counts[s.project] || 0) + 1;
    return Object.entries(counts).map(([project, count]) => ({ project, count }));
  }},
};

const db = {
  exec: (sql) => {
    // 只处理 server.js 实际用到的几种 SQL
    const s = String(sql).trim();
    if (/^DELETE\s+FROM\s+messages\s*;?\s*DELETE\s+FROM\s+sessions\s*;?\s*DELETE\s+FROM\s+meta\s+WHERE\s+k\s+LIKE\s+['"]offset:%['"]/i.test(s.replace(/\s+/g, ' '))) {
      clearAll();
      return;
    }
    const mReset = s.match(/DELETE\s+FROM\s+messages\s+WHERE\s+session_ref\s+LIKE\s+['"]([^'"]+):%['"];\s*DELETE\s+FROM\s+sessions\s+WHERE\s+agent\s*=\s+['"]([^'"]+)['"];\s*DELETE\s+FROM\s+hidden\s+WHERE\s+agent\s*=\s+['"]([^'"]+)['"]/i);
    if (mReset) { resetAgent(mReset[2]); return; }
    const mRepair = s.replace(/\s+/g, ' ').match(/UPDATE\s+sessions\s+SET\s+first_seen/i);
    if (mRepair) { repairSessionTimestamps(); return; }
    throw new Error('Unsupported SQL in JSON store: ' + s.slice(0, 80));
  },
  prepare: (sql) => ({
    get: () => ({ c: sessions.size }),
    all: () => [],
    run: () => ({ changes: 0 }),
  }),
};

const AGENT_META = {
  claude: { name: 'Claude Code', color: '#D97757' },
  codex: { name: 'Codex', color: '#10A37F' },
  workbuddy: { name: 'WorkBuddy', color: '#3B82F6' },
  deepseek: { name: 'DeepSeek Harness', color: '#4D6BFE' },
  marvis: { name: 'Marvis', color: '#7C3AED' },
  doubao: { name: '豆包', color: '#00A6F0' },
  other: { name: '其他', color: '#888780' },
};
function agentMeta(a) { return AGENT_META[a] || AGENT_META.other; }

function tx(fn) {
  const r = fn();
  scheduleSave();
  return r;
}

load();
process.on('beforeExit', save);
process.on('SIGINT', () => { save(); process.exit(0); });
process.on('SIGTERM', () => { save(); process.exit(0); });

module.exports = {
  ingest, touchActive, getActive, getRecentActive, getStats, getTimeline, getSession, getSessions, tx,
  agentMeta, AGENT_META, db, stmts, nowMs, extractUserQuery, smartTitle,
  hideSession, unhideSession, listHidden, deleteSessionByRef,
  clearAll, clearOffsets, resetAgent, repairSessionTimestamps,
  DATA_PATH,
};
