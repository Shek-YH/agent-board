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
const activeMap = new Map();  // ref -> { agent, project, title, lastActivity }（兼容保留，判定不再读取）
const lastMsgAt = new Map();  // ref -> ts  每会话「最后一条真实消息」时间（kind!=heartbeat/title）——进行中/活跃判定的唯一权威
const lastRole = new Map();   // ref -> 'user'|'assistant'  每会话最后一条真实消息的角色（桌面会话停顿检测用：agent 停笔 = 最后一条是 assistant）
const manualStatus = new Map(); // ref -> 'done'  手动标记为已完成（覆盖自动判定，同时跳过心跳跟踪）；无条目 = 自动判定
const agentStopAt = new Map(); // ref -> ts  agent 心跳停止时刻（内存态，不持久化）——提前结束「进行中」的辅助信号
const doneSignalAt = new Map(); // ref -> ts  agent 主动完成信号（/api/complete，持久化）——agent 明确声明本轮已结束；
                               // 只有「晚于信号时刻的新真实消息」才能解除，进程检查/心跳/停顿检测均不可覆盖
const futCache = new Map();   // ref -> { text, ts } 每个会话最早的用户消息（避免 O(N*M) 遍历）
const userMsgFlag = new Map(); // ref -> true  会话内存在真实用户指令（过滤系统注入后仍有内容）

let saveTimer = null;
const SAVE_DELAY_MS = 800;

function load() {
  if (!fs.existsSync(DATA_PATH)) return;
  try {
    const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));
    sessions.clear(); messages.clear(); meta.clear(); hidden.clear(); futCache.clear(); userMsgFlag.clear(); lastMsgAt.clear(); lastRole.clear(); manualStatus.clear(); agentStopAt.clear(); doneSignalAt.clear();
    const lastRoleInfo = new Map(); // 重建 lastRole 用的临时表（按 ts 取每个会话最后一条真实消息的 role）
    for (const s of data.sessions || []) {
      s.msg_count = 0;
      sessions.set(s.id, s);
    }
    for (const m of data.messages || []) {
      messages.set(`${m.agent}:${m.source_id}`, m);
      const s = sessions.get(m.session_ref);
      if (s) s.msg_count = (s.msg_count || 0) + 1;
      if ((m.ts || 0) > 0) {
        const cur = lastMsgAt.get(m.session_ref) || 0;
        if (m.ts > cur) lastMsgAt.set(m.session_ref, m.ts);
      }
      if (m.role === 'user' || m.role === 'assistant') {
        const cur = lastRoleInfo.get(m.session_ref);
        if (!cur || (m.ts || 0) >= cur.ts) lastRoleInfo.set(m.session_ref, { role: m.role, ts: m.ts || 0 });
      }
      if (m.role === 'user' && m.text) {
        const cur = futCache.get(m.session_ref);
        if (!cur || (m.ts || 0) < cur.ts) futCache.set(m.session_ref, { text: m.text, ts: m.ts || 0 });
        if (extractUserQuery(m.text)) userMsgFlag.set(m.session_ref, true);
      }
    }
    for (const kv of data.meta || []) meta.set(kv.k, kv.v);
    for (const h of data.hidden || []) hidden.set(`${h.agent}:${h.session_id}`, h);
    for (const m of data.manualStatus || []) if (m && m.ref && m.status) manualStatus.set(m.ref, m.status);
    for (const a of data.agentStopAt || []) if (a && a.ref && a.ts) agentStopAt.set(a.ref, a.ts);
    for (const d of data.doneSignalAt || []) if (d && d.ref && d.ts) doneSignalAt.set(d.ref, d.ts);
    for (const [ref, info] of lastRoleInfo) lastRole.set(ref, info.role);
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
    manualStatus: [...manualStatus.entries()].map(([ref, status]) => ({ ref, status })),
    agentStopAt: [...agentStopAt.entries()].map(([ref, ts]) => ({ ref, ts })),
    doneSignalAt: [...doneSignalAt.entries()].map(([ref, ts]) => ({ ref, ts })),
  };
  const json = JSON.stringify(data);
  // 首选：写临时文件 + 原子重命名（正常环境最安全，崩溃不留半截文件）
  const tmp = DATA_PATH + '.tmp';
  try {
    fs.writeFileSync(tmp, json, 'utf-8');
    fs.renameSync(tmp, DATA_PATH);
    return;
  } catch (e) {
    // 看门狗以 stdio:ignore 启动，console.error 不可见 → 错误落盘便于排查（360 锁等环境问题）
    logSaveError('rename', e);
  }
  // 回退：临时文件/重命名被安全软件临时锁定（360 等只拦删除重命名，不拦写入）→ 原地覆写。
  // 锁是瞬时的（实测 1-2 小时内自愈），短重试可覆盖窗口期，避免整轮保存静默丢失。
  for (let i = 0; i < 3; i++) {
    try {
      fs.writeFileSync(DATA_PATH, json, 'utf-8');
      return;
    } catch (e2) {
      logSaveError('inplace', e2);
      if (i < 2) {
        const t = Date.now();
        while (Date.now() - t < 1000) { /* busy-wait 1s，避免引入额外依赖 */ }
      }
    }
  }
}

// 保存失败落盘日志（避免被 stdio:ignore 吞掉）
function logSaveError(stage, err) {
  try {
    fs.appendFileSync(
      path.join(DATA_DIR, 'save-error.log'),
      `${new Date().toISOString()} [${stage}] ${err.code || ''} ${err.message}\n`
    );
  } catch { /* ignore */ }
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
  // 整段内容被已知系统注入标签包裹（开头位置）→ 视为非真实用户输入
  if (/^<(recommended_plugins|permissions instructions|collaboration_mode|plugins_instructions|apps_instructions|environment_context|sandbox_requirements|memory_instructions)>/.test(t)) return '';
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

// 「回合结束」信号去重（agent 自身格式里的显式完成标记，见 T1，各 adapter 派生）：
// 只用来防止同一底层事件（scanAll 重放 / poll 重复触发）被处理多次，不持久化——
// 重放代价只是再 set 一次 doneSignalAt（幂等），重启后丢失也无副作用。
const turnEndSeen = new Set(); // "agent:sourceId"

// 统一入库入口
function ingest(msg) {
  const ref = msg.agent + ':' + msg.sessionId;
  // 「回合结束」显式信号（kind='turn_end'，各 adapter 从自身格式里派生，如 Claude 的
  // stop_reason!=='tool_use' / Codex 的 task_complete / ZCode 的 step-finish reason=stop /
  // Pi 的 stopReason=stop）：不是真实消息，不进 sessions/messages/lastMsgAt/lastRole，
  // 只设置 doneSignalAt——语义上等价于 agent 主动调用 /api/complete，但由看板直接从转录
  // 文件读出，不依赖 hook/模型是否记得执行指令。
  if (msg.kind === 'turn_end') {
    const key = msg.agent + ':' + msg.sourceId;
    if (turnEndSeen.has(key)) return ref;
    turnEndSeen.add(key);
    setDoneSignal(ref, msg.ts || nowMs());
    return ref;
  }
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
    // 手动标记完成后的「新指令自动恢复」：一旦该会话出现新的真实消息（用户新指令 / AI 新回复，
    // 且非 scanAll 重放的历史消息），自动清除 manualStatus，让会话重新参与「进行中」判定，
    // 直到再次无消息超过 10 分钟又自动回到「已完成」。时间窗过滤保证全量扫描重放不误清除。
    if (!existed && (msg.ts || 0) > nowMs() - 10 * 60 * 1000) {
      manualStatus.delete(ref);
      // 停止标记（心跳停止/进程消失/停顿检测设置）：新消息即解除。
      // 完成信号（doneSignalAt）与停止标记（agentStopAt）都只被「晚于其记录时刻」的新消息解除——
      // 防止 watcher 延迟 ingest 的历史消息（ts 早于信号时刻）把刚发出的完成信号误顶回去。
      const stopAt = agentStopAt.get(ref);
      if (!stopAt || (msg.ts || 0) > stopAt) agentStopAt.delete(ref);
      const sigAt = doneSignalAt.get(ref);
      if (!sigAt || (msg.ts || 0) > sigAt) doneSignalAt.delete(ref);
    }
    messages.set(key, {
      agent: msg.agent, source_id: msg.sourceId, session_ref: ref,
      ts: msg.ts || 0, role: msg.role || '', kind: msg.kind || 'message', text: msg.text || '',
    });
    // 真实消息时间戳 → lastMsgAt（取 max 防乱序 ingest 回退）
    if (msg.ts > 0) {
      const cur = lastMsgAt.get(ref) || 0;
      if (msg.ts > cur) lastMsgAt.set(ref, msg.ts);
    }
    // 真实消息角色 → lastRole（agent 是否已停笔的辅助判定；仅当该消息就是最新一条时更新，防乱序回放覆盖）
    if ((msg.role === 'user' || msg.role === 'assistant') && msg.ts >= (lastMsgAt.get(ref) || 0)) {
      lastRole.set(ref, msg.role);
    }
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

let lastExpireMs = 0;
function maybeExpire(withinMs) {
  // 节流：每 30s 才真正遍历清理一次，避免热路径（getActive / getSessions）每次都 O(N) 扫描
  const t = nowMs();
  if (t - lastExpireMs < 30 * 1000) return;
  lastExpireMs = t;
  const cutoff = t - withinMs;
  for (const [k, v] of activeMap) {
    if (v.lastActivity < cutoff) activeMap.delete(k);
  }
}

let lastExpireMsgMs = 0;
function maybeExpireMsg(withinMs) {
  // lastMsgAt 的节流清理：防止 Map 无限膨胀（getActive / getSessions 每 30s 最多扫一次）
  const t = nowMs();
  if (t - lastExpireMsgMs < 30 * 1000) return;
  lastExpireMsgMs = t;
  const cutoff = t - withinMs;
  for (const [k, v] of lastMsgAt) if (v < cutoff) lastMsgAt.delete(k);
}

function getActive() {
  // 进行中 = 最后一条「真实消息」距今 < 10 分钟，且 agent 心跳未停止（停止 → 提前视为完成）。
  // 不读 activeMap——activeMap 会被心跳类 touchActive 用 now 持续顶起（WorkBuddy 关 tab 后仍保活），
  // 用它判 active 会把已结束的会话永久标成「进行中」。
  maybeExpireMsg(10 * 60 * 1000);
  const now = nowMs();
  return [...lastMsgAt.entries()]
    .filter(([ref]) => isLiveRef(ref, now))
    .map(([ref, lastActivity]) => {
      const s = sessions.get(ref);
      return {
        sessionRef: ref,
        agent: (s && s.agent) || 'other',
        project: (s && s.project) || '',
        title: (s && (s.title || smartTitle(userQueryForSession(ref)))) || '',
        lastActivity,
      };
    });
}

// 「进行中」统一判定（getActive / getSessions.status / getRecentActive.live 共用）：
//   1. 最后真实消息距今 < 10 分钟（10 分钟窗口兜底，容忍思考/工具执行间隙）
//   2. 非手动标记完成
//   3. agent 心跳未停止：心跳停止（进程退出 = 任务结束）→ 提前结束「进行中」，不必等满 10 分钟窗口
//   4. 无 agent 主动完成信号（/api/complete）：agent 明确声明本轮结束 → 立即结束，且只有新消息能解除
function isLiveRef(ref, now) {
  const ts = lastMsgAt.get(ref);
  if (!ts || ts < now - 10 * 60 * 1000) return false;
  if (manualStatus.has(ref)) return false;
  if (agentStopAt.has(ref)) return false;
  if (doneSignalAt.has(ref)) return false;
  return true;
}

// agent 主动完成信号：记录信号时刻（持久化）。只有晚于该时刻的新真实消息（ingest）才能解除。
function setDoneSignal(ref, ts) {
  doneSignalAt.set(ref, ts || nowMs());
  scheduleSave();
}

// 心跳信号：alive=true → agent 进程在跑（清除停止标记）；alive=false → 心跳已停 → 记录停止时刻
function setAgentActive(ref, alive, ts) {
  if (alive) {
    if (agentStopAt.delete(ref)) scheduleSave();
  } else {
    const prev = agentStopAt.get(ref) || 0;
    if (ts > prev) { agentStopAt.set(ref, ts); scheduleSave(); }
  }
}

// 按 agent 批量设置（进程检查用）：进程全无 → 该 agent 所有窗口内 session 提前完成；
// 进程在 → 清除停止标记（可能 resume）
function setAgentStopped(agent, stopped, ts) {
  let changed = false;
  for (const [ref] of lastMsgAt) {
    if (!ref.startsWith(agent + ':')) continue;
    if (stopped) {
      const prev = agentStopAt.get(ref) || 0;
      if (ts > prev) { agentStopAt.set(ref, ts); changed = true; }
    } else if (agentStopAt.delete(ref)) {
      changed = true;
    }
  }
  if (changed) scheduleSave();
}

// 每会话最后一条真实消息的角色（停顿检测用）：无消息返回 null
function getLastRole(ref) {
  return lastRole.get(ref) || null;
}

// 把 agent + 外部 sessionId（agent hook/脚本提供，格式可能与内部 ref 不一致）解析为内部 ref。
// 1) sessionId 精确匹配 agent:sessionId
// 2) 后缀匹配：如 codex hook 给的是 uuid，内部 sessionId 是 "2026-08-21T09-10-28-<uuid>" → endsWith 命中
// 3) sessionId 为空或都匹配不上 → 该 agent 最近活跃（lastMsgAt 最大）的会话（指令式兜底）
function resolveAgentRef(agent, sessionId) {
  if (sessionId) {
    const exact = agent + ':' + sessionId;
    if (sessions.has(exact)) return exact;
    let best = null, bestTs = 0;
    for (const [ref, s] of sessions) {
      if (s.agent !== agent) continue;
      const sid = String(s.session_id || '');
      if (!sid) continue;
      if (sid === sessionId || sid.endsWith(sessionId) || sessionId.endsWith(sid)) {
        const t = lastMsgAt.get(ref) || s.last_seen || 0;
        if (t > bestTs) { best = ref; bestTs = t; }
      }
    }
    if (best) return best;
  }
  let best = null, bestTs = 0;
  for (const [ref, s] of sessions) {
    if (s.agent !== agent) continue;
    const t = lastMsgAt.get(ref) || 0;
    if (t > bestTs) { best = ref; bestTs = t; }
  }
  return best;
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
  maybeExpireMsg(10 * 60 * 1000);
  return list.slice(start, start + l).map(s => ({
    ...s,
    title: s.title || smartTitle(userQueryForSession(s.id)) || s.session_id.slice(0, 12),
    // 手动标记 done 优先于自动判定
    status: isLiveRef(s.id, now) ? 'active' : 'done',
    manual_done: !!manualStatus.get(s.id),
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
      // live 与 getActive 同口径：最后真实消息距今 < 10 分钟 且 心跳未停止；手动标记完成永远非 live
      live: isLiveRef(s.id, now),
      has_user: !!userMsgFlag.get(s.id),
    }));
}

function hideSession(agent, sessionId) {
  hidden.set(agent + ':' + sessionId, { agent, session_id: sessionId, at: Date.now() });
  scheduleSave();
}

// 手动设置会话状态：'done' = 标记为已完成（覆盖自动判定，同时心跳跳过该会话）；'auto' = 恢复自动判定
function setManualStatus(agent, sessionId, status) {
  const ref = agent + ':' + sessionId;
  if (!sessions.has(ref)) throw new Error('会话不存在: ' + ref);
  if (status === 'done') manualStatus.set(ref, 'done');
  else manualStatus.delete(ref); // 'auto' / 其他值一律恢复自动判定
  scheduleSave();
  return manualStatus.has(ref) ? 'done' : 'auto';
}
function isManuallyDone(ref) { return manualStatus.has(ref); }

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
  lastMsgAt.delete(ref);
  lastRole.delete(ref);
  manualStatus.delete(ref);
  agentStopAt.delete(ref);
  doneSignalAt.delete(ref);
  scheduleSave();
  return 1;
}

// rescan / 管理用的高级 API
function clearAll() {
  sessions.clear(); messages.clear(); meta.clear(); hidden.clear(); futCache.clear(); userMsgFlag.clear(); lastMsgAt.clear(); lastRole.clear(); manualStatus.clear(); agentStopAt.clear(); doneSignalAt.clear();
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
  for (const [k] of lastMsgAt) if (k.startsWith(agent + ':')) lastMsgAt.delete(k);
  for (const [k] of lastRole) if (k.startsWith(agent + ':')) lastRole.delete(k);
  for (const [k] of manualStatus) if (k.startsWith(agent + ':')) manualStatus.delete(k);
  for (const [k] of agentStopAt) if (k.startsWith(agent + ':')) agentStopAt.delete(k);
  for (const [k] of doneSignalAt) if (k.startsWith(agent + ':')) doneSignalAt.delete(k);
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

// 修复 futCache：扫描 messages 找每会话第一条 extractUserQuery 真实有内容的 user 消息
// 用于 adapter 加了新过滤规则后，存量数据里早先误标的"系统注入"消息已经入库且被 futCache
// 锁定为"首条用户消息"——重启后 ingest 不会替换（只前进不后退）。
// 显式重置 futCache + userMsgFlag，按消息时序从 0 重新计算。
function repairUserQueries() {
  // 收集每会话 user 消息（按时序）
  const byRef = new Map();
  for (const m of messages.values()) {
    if (m.role !== 'user' || !m.text) continue;
    if (!byRef.has(m.session_ref)) byRef.set(m.session_ref, []);
    byRef.get(m.session_ref).push(m);
  }
  for (const [ref, list] of byRef) {
    list.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    let first = null;
    for (const m of list) {
      if (extractUserQuery(m.text)) { first = m; break; }
    }
    if (first) {
      futCache.set(ref, { text: first.text, ts: first.ts || 0 });
      userMsgFlag.set(ref, true);
    } else {
      futCache.delete(ref);
      userMsgFlag.delete(ref);
    }
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
    const projects = new Map();
    for (const s of sessions.values()) {
      if (!s.project || hidden.has(s.id)) continue;
      const current = projects.get(s.project) || { project: s.project, cnt: 0, lastSeen: 0 };
      projects.set(s.project, {
        ...current,
        cnt: current.cnt + 1,
        lastSeen: Math.max(current.lastSeen, s.last_seen || 0),
      });
    }
    return [...projects.values()].sort((a, b) => b.lastSeen - a.lastSeen);
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
  zcode: { name: 'ZCode', color: '#1772F0' },
  pi: { name: 'Pi Agent', color: '#01BEBF' },
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
  setManualStatus, isManuallyDone,
  setAgentActive, setAgentStopped, isLiveRef, getLastRole, resolveAgentRef, setDoneSignal,
  clearAll, clearOffsets, resetAgent, repairSessionTimestamps, repairUserQueries,
  DATA_PATH,
};
