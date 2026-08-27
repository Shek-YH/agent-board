'use strict';
// 存储层：JSON 快照 + 内存索引
// 原 SQLite 方案在 Node 22 + 360 环境下会被误判锁定，
// 改用 JSON 文件持久化，运行时全量加载到内存，避免数据库文件被安全软件拦截。
const fs = require('fs');
const path = require('path');
const codexStatus = require('./codex-status');
const { getDataDir } = require('./runtime-paths');
const {
  normalizeTopologyMessage,
  mergeTopology,
  summarizeTopology,
  resolveControlTarget: resolveTopologyControlTarget,
} = require('./session-topology');

const DATA_DIR = getDataDir();
const DATA_PATH = path.join(DATA_DIR, 'data.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// 内存数据结构
const sessions = new Map();   // id -> session
const messages = new Map();   // "agent:source_id" -> message
const messagesBySession = new Map(); // ref -> ("agent:source_id" -> message)，详情抽屉按 session 读取
const meta = new Map();       // k -> v
const hidden = new Map();     // "agent:session_id" -> { agent, session_id, at }
const activeMap = new Map();  // ref -> { agent, project, title, lastActivity }；Codex 用日志写入时间维持长工具调用期间的活跃态
const lastMsgAt = new Map();  // ref -> ts  每会话「最后一条真实消息」时间（kind!=heartbeat/title）——无外部状态时的活跃依据
const lastRole = new Map();   // ref -> 'user'|'assistant'  每会话最后一条真实消息的角色（桌面会话停顿检测用：agent 停笔 = 最后一条是 assistant）
const manualStatus = new Map(); // ref -> 'done'  手动标记为已完成（覆盖自动判定，同时跳过心跳跟踪）；无条目 = 自动判定
const agentStopAt = new Map(); // ref -> ts  agent 心跳停止时刻（内存态，不持久化）——提前结束「进行中」的辅助信号
const doneSignalAt = new Map(); // ref -> ts  agent 主动完成信号（/api/complete，持久化）——agent 明确声明本轮已结束；
                               // 只有「晚于信号时刻的新真实消息」才能解除，进程检查/心跳/停顿检测均不可覆盖
const externalDoneAt = new Map(); // ref -> WorkBuddy 外部数据库终态时间（内存态）——心跳和停顿检测不可覆盖
const externalActiveAt = new Map(); // ref -> WorkBuddy 外部数据库 active 状态时间（内存态）——允许长时间运行会话保持 active
const pendingCodexDone = new Map(); // ref -> { signalTs, dueAt } Codex task_complete 的 60 秒观察期（内存态）
const codexRuntime = new Map(); // ref -> Codex thread/turn runtime state（从 JSONL 生命周期事件归并）
const futCache = new Map();   // ref -> { text, ts } 每个会话最早的用户消息（避免 O(N*M) 遍历）
const latestUserCache = new Map(); // ref -> { text, ts } 每个会话最近的真实用户消息
const userMsgFlag = new Map(); // ref -> true  会话内存在真实用户指令（过滤系统注入后仍有内容）

let saveTimer = null;
let saveInFlight = null;
let saveAgain = false;
let shuttingDown = false;
const SAVE_DELAY_MS = 800;

const CODEX_UUID_SUFFIX = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

function canonicalSessionRef(ref) {
  const raw = String(ref || '');
  if (!raw.startsWith('codex:')) return raw;
  const sessionId = raw.slice('codex:'.length);
  const match = sessionId.match(CODEX_UUID_SUFFIX);
  return match ? `codex:${match[1]}` : raw;
}

function canonicalCodexSourceId(sourceId, oldRef, newRef) {
  if (!oldRef.startsWith('codex:') || oldRef === newRef) return sourceId;
  const oldId = oldRef.slice('codex:'.length);
  const newId = newRef.slice('codex:'.length);
  const raw = String(sourceId || '');
  return raw.startsWith(`${oldId}:`) ? `${newId}${raw.slice(oldId.length)}` : raw;
}

function indexMessage(key, message) {
  let bucket = messagesBySession.get(message.session_ref);
  if (!bucket) {
    bucket = new Map();
    messagesBySession.set(message.session_ref, bucket);
  }
  bucket.set(key, message);
}

function removeIndexedMessage(key, message) {
  const bucket = messagesBySession.get(message && message.session_ref);
  if (!bucket) return;
  bucket.delete(key);
  if (!bucket.size) messagesBySession.delete(message.session_ref);
}

function setStoredMessage(key, message) {
  const previous = messages.get(key);
  if (previous && previous.session_ref !== message.session_ref) removeIndexedMessage(key, previous);
  messages.set(key, message);
  indexMessage(key, message);
}

function deleteStoredMessage(key) {
  const message = messages.get(key);
  if (!message) return;
  messages.delete(key);
  removeIndexedMessage(key, message);
}

function load() {
  if (!fs.existsSync(DATA_PATH)) return;
  try {
    const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));
    sessions.clear(); messages.clear(); messagesBySession.clear(); meta.clear(); hidden.clear(); futCache.clear(); latestUserCache.clear(); userMsgFlag.clear(); lastMsgAt.clear(); lastRole.clear(); manualStatus.clear(); agentStopAt.clear(); doneSignalAt.clear(); externalDoneAt.clear(); externalActiveAt.clear(); pendingCodexDone.clear(); codexRuntime.clear();
    const lastRoleInfo = new Map(); // 重建 lastRole 用的临时表（按 ts 取每个会话最后一条真实消息的 role）
    for (const s of data.sessions || []) {
      const oldRef = String(s.id || `${s.agent}:${s.session_id || ''}`);
      const newRef = canonicalSessionRef(oldRef);
      if (newRef !== oldRef) {
        s.id = newRef;
        s.session_id = newRef.slice(String(s.agent || '').length + 1);
        if (s.parent_session_ref) s.parent_session_ref = canonicalSessionRef(s.parent_session_ref);
        if (s.root_session_ref) s.root_session_ref = canonicalSessionRef(s.root_session_ref);
      }
      s.msg_count = 0;
      Object.assign(s, mergeTopology(s, normalizeTopologyMessage({
        agent: s.agent,
        sessionId: s.session_id,
        sessionRole: s.session_role,
        parentSessionRef: s.parent_session_ref,
        rootSessionRef: s.root_session_ref,
        topologySource: s.topology_source,
        topologyConfidence: s.topology_confidence,
        childDetection: s.child_detection,
        controlEligibility: s.control_eligibility,
      })));
      const existing = sessions.get(s.id);
      if (existing) Object.assign(existing, mergeTopology(existing, s));
      else sessions.set(s.id, s);
    }
    for (const m of data.messages || []) {
      const oldRef = String(m.session_ref || '');
      const newRef = canonicalSessionRef(oldRef);
      m.session_ref = newRef;
      m.source_id = canonicalCodexSourceId(m.source_id, oldRef, newRef);
      setStoredMessage(`${m.agent}:${m.source_id}`, m);
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
        rememberLatestUserQuery(m.session_ref, m.text, m.ts);
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
  if (saveInFlight) {
    saveAgain = true;
    return saveInFlight;
  }
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
  // 使用进程独立的临时文件，避免两个 Agent Board 版本同时运行时互相删临时文件。
  // 写盘和回退都走 Promise，不能让 80MB 快照阻塞 HTTP 事件循环。
  const tmp = `${DATA_PATH}.${process.pid}.tmp`;
  saveInFlight = fs.promises.writeFile(tmp, json, 'utf-8')
    .then(() => fs.promises.rename(tmp, DATA_PATH))
    .catch((error) => {
      logSaveError('rename', error);
      return fs.promises.writeFile(DATA_PATH, json, 'utf-8')
        .catch((fallbackError) => logSaveError('inplace', fallbackError));
    })
    .finally(() => {
      saveInFlight = null;
      if (saveAgain && !shuttingDown) {
        saveAgain = false;
        scheduleSave();
      }
    });
  return saveInFlight;
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

function rememberLatestUserQuery(ref, text, ts) {
  if (!extractUserQuery(text)) return;
  const candidateTs = Number(ts) || 0;
  const current = latestUserCache.get(ref);
  if (!current || candidateTs >= current.ts) latestUserCache.set(ref, { text, ts: candidateTs });
}

function shouldAdvanceSessionTime(kind) {
  return kind !== 'heartbeat' && kind !== 'title';
}

function isExternalCompletionActive(lastMessageAt, statusAt) {
  const last = Number(lastMessageAt) || 0;
  const doneAt = Number(statusAt) || 0;
  return doneAt > 0 && (!last || last <= doneAt);
}

function userQueryForSession(ref) {
  const c = futCache.get(ref);
  return c ? extractUserQuery(c.text || '') : '';
}

function latestUserQueryForSession(ref) {
  const c = latestUserCache.get(ref);
  return c ? extractUserQuery(c.text || '') : '';
}

function selectSessionCardUserText(agent, firstQuery, latestQuery) {
  return latestQuery || firstQuery;
}

// 「回合结束」信号去重（agent 自身格式里的显式完成标记，见 T1，各 adapter 派生）：
// 只用来防止同一底层事件（scanAll 重放 / poll 重复触发）被处理多次，不持久化——
// 重放代价只是再 set 一次 doneSignalAt（幂等），重启后丢失也无副作用。
const turnEndSeen = new Set(); // "agent:sourceId"

// 统一入库入口
function ingest(msg) {
  const ref = msg.agent + ':' + msg.sessionId;
  const topology = normalizeTopologyMessage(msg);
  let changed = false;
  // 「回合结束」显式信号（kind='turn_end'，各 adapter 从自身格式里派生，如 Claude 的
  // stop_reason!=='tool_use' / ZCode 的 step-finish reason=stop /
  // Pi 的 stopReason=stop）：不是真实消息，不进 sessions/messages/lastMsgAt/lastRole，
  // 只设置 doneSignalAt——语义上等价于 agent 主动调用 /api/complete，但由看板直接从转录
  // 文件读出，不依赖 hook/模型是否记得执行指令。
  if (msg.kind === 'turn_end') {
    const key = msg.agent + ':' + msg.sourceId;
    if (turnEndSeen.has(key)) return ref;
    turnEndSeen.add(key);
    if (msg.agent === 'codex') noteCodexTurnEvent(ref, msg);
    if (msg.agent === 'codex' && msg.completionHoldMs > 0) setPendingCodexDone(ref, msg.ts || nowMs(), msg.completionHoldMs);
    else setDoneSignal(ref, msg.ts || nowMs());
    return ref;
  }
  if (msg.kind === 'turn_start') {
    if (msg.agent === 'codex') noteCodexTurnEvent(ref, msg);
    touchActive(ref, { agent: msg.agent, project: msg.project || '', title: msg.title || '' }, nowMs());
    scheduleSave();
    return ref;
  }
  const isMeta = !shouldAdvanceSessionTime(msg.kind);
  let s = sessions.get(ref);
  if (!s) {
    s = {
      id: ref, agent: msg.agent, session_id: String(msg.sessionId),
      project: msg.project || '', title: msg.title || '',
      first_seen: msg.ts || 0, last_seen: msg.ts || 0, msg_count: 0,
      ...topology,
    };
    sessions.set(ref, s);
    changed = true;
  } else {
    const mergedTopology = mergeTopology(s, topology);
    for (const key of ['session_role', 'parent_session_ref', 'root_session_ref', 'topology_source', 'topology_confidence', 'child_detection', 'control_eligibility']) {
      if (s[key] !== mergedTopology[key]) changed = true;
    }
    Object.assign(s, mergedTopology);
    if (msg.project && s.project !== msg.project) { s.project = msg.project; changed = true; }
    if (msg.title && s.title !== msg.title) { s.title = msg.title; changed = true; }
    if (msg.ts > 0 && shouldAdvanceSessionTime(msg.kind)) {
      if (!s.first_seen || msg.ts < s.first_seen) { s.first_seen = msg.ts; changed = true; }
      if (msg.ts > s.last_seen) { s.last_seen = msg.ts; changed = true; }
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
      const externalAt = externalDoneAt.get(ref);
      if (!externalAt || (msg.ts || 0) > externalAt) externalDoneAt.delete(ref);
    }
    const nextMessage = {
      agent: msg.agent, source_id: msg.sourceId, session_ref: ref,
      ts: msg.ts || 0, role: msg.role || '', kind: msg.kind || 'message', text: msg.text || '',
    };
    const previousMessage = messages.get(key);
    if (!previousMessage || ['agent', 'source_id', 'session_ref', 'ts', 'role', 'kind', 'text'].some((field) => previousMessage[field] !== nextMessage[field])) changed = true;
    setStoredMessage(key, nextMessage);
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
      rememberLatestUserQuery(ref, msg.text, msg.ts);
      if (extractUserQuery(msg.text)) userMsgFlag.set(ref, true);
    }
  }

  if (!isMeta) touchActive(ref, { agent: msg.agent, project: msg.project || '', title: msg.title || '' }, msg.ts);
  if (changed) scheduleSave();
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
  }
  return merged;
}

function setPendingCodexDone(ref, signalTs, holdMs) {
  const completedAt = signalTs || nowMs();
  pendingCodexDone.set(ref, { signalTs: completedAt, dueAt: completedAt + holdMs });
}

function getCodexRuntime(ref) {
  let state = codexRuntime.get(ref);
  if (!state) {
    state = codexStatus.createCodexRuntimeState(ref.slice('codex:'.length));
    codexRuntime.set(ref, state);
  }
  return state;
}

function noteCodexTurnEvent(ref, event) {
  const state = codexStatus.applyCodexTurnEvent(getCodexRuntime(ref), event);
  codexRuntime.set(ref, state);
}

function noteCodexThreadStatus(ref, status, ts) {
  const state = codexStatus.applyCodexThreadStatus(getCodexRuntime(ref), status, ts);
  codexRuntime.set(ref, state);
  scheduleSave();
}

function getCodexRuntimeStatus(ref, now = nowMs()) {
  const state = codexRuntime.get(ref);
  if (state) return codexStatus.toPublicCodexStatus(state, now);
  return {
    threadId: ref.slice('codex:'.length),
    threadStatus: 'unknown',
    activeFlags: [],
    activeTurnId: null,
    latestTurnId: null,
    latestTurnStatus: null,
    state: isLiveRef(ref, now) ? 'running' : 'completed',
    startedAt: null,
    completedAt: null,
    lastEventAt: 0,
    source: 'activity_window',
  };
}

function getRuntimeStatuses(now = nowMs()) {
  const statuses = {};
  for (const [ref, session] of sessions) {
    if (session.agent === 'codex') statuses[ref] = getCodexRuntimeStatus(ref, now);
  }
  for (const ref of codexRuntime.keys()) {
    if (!statuses[ref]) statuses[ref] = getCodexRuntimeStatus(ref, now);
  }
  return statuses;
}

// Codex 的普通新日志（包括无文本的 reasoning / custom_tool）只作为活跃证据，
// 不单独确认新回合，避免 bookkeeping 事件误撤销完成候选。
function noteCodexActivity(ref, sourceTs, info) {
  // 旧版进程检查可能留下 Codex 停止标记；新的 JSONL 活动证明会话仍在运行，立即解除该误判。
  if (ref.startsWith('codex:') && agentStopAt.delete(ref)) scheduleSave();
  if (ref.startsWith('codex:')) {
    const state = codexStatus.applyCodexActivity(getCodexRuntime(ref), nowMs());
    codexRuntime.set(ref, state);
  }
  touchActive(ref, info, nowMs());
}

// task_started 或真实用户消息确认了 task_complete 后的新回合。
function confirmCodexContinuation(ref, sourceTs, info) {
  const ts = Number(sourceTs) || 0;
  let changed = false;
  const pending = pendingCodexDone.get(ref);
  if (pending && ts > pending.signalTs) { pendingCodexDone.delete(ref); changed = true; }
  const doneAt = doneSignalAt.get(ref) || 0;
  if (doneAt && ts > doneAt) { doneSignalAt.delete(ref); changed = true; }
  touchActive(ref, info, nowMs());
  if (changed) scheduleSave();
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
  for (const [k, v] of lastMsgAt) {
    // Codex 的 reasoning / custom_tool 行没有可展示文本，却仍持续证明会话在运行；
    // 最近日志写入存在时保留其真实消息索引，避免长工具调用在 10 分钟后被错误过期。
    if (v < cutoff && !(k.startsWith('codex:') && (activeMap.get(k)?.lastActivity || 0) >= cutoff)) lastMsgAt.delete(k);
  }
}

function getActive() {
  // 进行中 = 最后一条「真实消息」距今 < 10 分钟，或 WorkBuddy 外部状态仍 active，
  // 且 agent 心跳未停止（停止 → 提前视为完成）。
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
        runtime_status: ref.startsWith('codex:') ? getCodexRuntimeStatus(ref, now) : null,
      };
    });
}

// 「进行中」统一判定（getActive / getSessions.status / getRecentActive.live 共用）：
//   1. 最后真实消息距今 < 10 分钟；Codex 另允许最近的日志写入维持活跃（容忍思考/工具执行间隙）
//   2. 非手动标记完成
//   3. agent 心跳未停止：心跳停止（进程退出 = 任务结束）→ 提前结束「进行中」，不必等满 10 分钟窗口
//   4. 无 agent 主动完成信号（/api/complete）：agent 明确声明本轮结束 → 立即结束，且只有新消息能解除
function isLiveRef(ref, now) {
  const ts = lastMsgAt.get(ref);
  const freshCodexLog = ref.startsWith('codex:') && (activeMap.get(ref)?.lastActivity || 0) >= now - 10 * 60 * 1000;
  const freshExternalStatus = externalActiveAt.has(ref);
  if ((!ts || ts < now - 10 * 60 * 1000) && !freshCodexLog && !freshExternalStatus) return false;
  if (manualStatus.has(ref)) return false;
  if (agentStopAt.has(ref)) return false;
  if (isExternalCompletionActive(lastMsgAt.get(ref), externalDoneAt.get(ref))) return false;
  const pending = pendingCodexDone.get(ref);
  if (pending) {
    if (now < pending.dueAt) return true;
    pendingCodexDone.delete(ref);
    setDoneSignal(ref, pending.signalTs);
  }
  if (doneSignalAt.has(ref)) return false;
  return true;
}

// agent 主动完成信号：记录信号时刻（持久化）。只有晚于该时刻的新真实消息（ingest）才能解除。
function setDoneSignal(ref, ts) {
  doneSignalAt.set(ref, ts || nowMs());
  scheduleSave();
}

// WorkBuddy 自带数据库的状态信号：只接受单调前进的状态时间，且旧状态不能覆盖更晚的真实消息。
function noteExternalStatus(ref, status) {
  if (!status || !status.statusAt) return false;
  const statusAt = Number(status.statusAt) || 0;
  if (status.terminal) {
    if ((lastMsgAt.get(ref) || 0) > statusAt) return false;
    const previous = externalDoneAt.get(ref) || 0;
    if (statusAt < previous) return false;
    externalActiveAt.delete(ref);
    externalDoneAt.set(ref, statusAt);
    return true;
  }
  if (status.active) {
    const previous = externalDoneAt.get(ref) || 0;
    let changed = false;
    if (previous && statusAt >= previous) changed = externalDoneAt.delete(ref) || changed;
    const activePrevious = externalActiveAt.get(ref) || 0;
    if (statusAt >= activePrevious) {
      externalActiveAt.set(ref, statusAt);
      changed = true;
    }
    return changed;
  }
  return false;
}

// 升级到 Codex 观察期时，清理旧版本把 task_complete/静默直接持久化为完成的记录。
function migrateCodexCompletionSignals() {
  const key = 'migration:codex-turn-completion-hold-v1';
  if (meta.has(key)) return false;
  let changed = false;
  for (const ref of doneSignalAt.keys()) {
    if (ref.startsWith('codex:')) { doneSignalAt.delete(ref); changed = true; }
  }
  meta.set(key, '1');
  scheduleSave();
  return changed;
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
  const msgs = [...(messagesBySession.get(ref)?.values() || [])]
    .sort((a, b) => a.ts - b.ts);
  return {
    ...s,
    runtime_status: ref.startsWith('codex:') ? getCodexRuntimeStatus(ref) : null,
    messages: msgs,
  };
}

function getSessionTitle(ref) {
  const s = sessions.get(ref);
  return s ? s.title : undefined;
}

function normalizeProjectPath(value) {
  return String(value || '').trim().replace(/[\\/]+$/, '').toLowerCase();
}

function matchesSessionQuery(session, q, projectPaths, userQuery = '') {
  const rawQ = String(q || '').trim();
  const qs = rawQ.toLowerCase();
  if (!qs) return true;
  const projectQuery = normalizeProjectPath(rawQ);
  if (projectPaths.has(projectQuery)) {
    return normalizeProjectPath(session.project) === projectQuery;
  }
  const hay = ((session.title || '') + ' ' + (session.project || '') + ' ' + userQuery).toLowerCase();
  return hay.includes(qs);
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
    const projectPaths = new Set([...sessions.values()]
      .map(s => normalizeProjectPath(s.project))
      .filter(Boolean));
    list = list.filter(s => matchesSessionQuery(s, q, projectPaths, userQueryForSession(s.id)));
  }
  const idx = list.findIndex(s => s.last_seen < c);
  const start = idx >= 0 ? idx : 0;
  const now = nowMs();
  maybeExpireMsg(10 * 60 * 1000);
  const topologySummary = summarizeTopology(list, now);
  return list.slice(start, start + l).map(s => {
    const firstQuery = userQueryForSession(s.id);
    const latestQuery = latestUserQueryForSession(s.id);
    const children = topologySummary.get(s.id) || { child_count: 0, active_child_count: 0 };
    return {
      ...s,
      ...children,
      title: s.title || smartTitle(firstQuery) || s.session_id.slice(0, 12),
      // 手动标记 done 优先于自动判定
      status: isLiveRef(s.id, now) ? 'active' : 'done',
      runtime_status: s.agent === 'codex' ? getCodexRuntimeStatus(s.id, now) : null,
      manual_done: !!manualStatus.get(s.id),
      last_user_text: selectSessionCardUserText(s.agent, firstQuery, latestQuery).slice(0, 4000),
      has_user: !!userMsgFlag.get(s.id),
    };
  });
}

function getRecentActive(range = 'day') {
  let cutoff;
  const d = new Date();
  if (range === '24h') cutoff = nowMs() - 24 * 3600 * 1000;
  else if (range === 'week') cutoff = nowMs() - 7 * 24 * 3600 * 1000;
  else if (range === 'month') cutoff = nowMs() - 30 * 24 * 3600 * 1000;
  else { d.setHours(0, 0, 0, 0); cutoff = d.getTime(); }
  const now = nowMs();
  const list = [...sessions.values()]
    .filter(s => s.last_seen >= cutoff && !hidden.has(s.id))
    .sort((a, b) => b.last_seen - a.last_seen);
  const topologySummary = summarizeTopology(list, now);
  return list.map(s => {
    const children = topologySummary.get(s.id) || { child_count: 0, active_child_count: 0 };
    return ({
      sessionRef: s.id,
      agent: s.agent,
      project: s.project || '',
      title: s.title || smartTitle(userQueryForSession(s.id)),
      lastActivity: s.last_seen,
      msgCount: s.msg_count || 0,
      // live 与 getActive 同口径：最后真实消息距今 < 10 分钟 且 心跳未停止；手动标记完成永远非 live
      live: isLiveRef(s.id, now),
      runtime_status: s.agent === 'codex' ? getCodexRuntimeStatus(s.id, now) : null,
      has_user: !!userMsgFlag.get(s.id),
      ...children,
    });
  });
}

// AI 监督器或自动托管层使用的严格目标解析：只返回明确可控的主会话，
// 不复用 resolveAgentRef 的“最近活跃”兜底，避免把指令发错到子代理或另一条主会话。
function resolveSessionControlTarget(options = {}) {
  const visible = [...sessions.values()].filter(s => !hidden.has(s.id));
  return resolveTopologyControlTarget(visible, options);
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
  for (const [k, m] of messages) if (m.session_ref === ref) deleteStoredMessage(k);
  messagesBySession.delete(ref);
  hidden.delete(ref);
  futCache.delete(ref);
  latestUserCache.delete(ref);
  userMsgFlag.delete(ref);
  lastMsgAt.delete(ref);
  lastRole.delete(ref);
  manualStatus.delete(ref);
  agentStopAt.delete(ref);
  doneSignalAt.delete(ref);
  externalDoneAt.delete(ref);
  externalActiveAt.delete(ref);
  codexRuntime.delete(ref);
  scheduleSave();
  return 1;
}

// rescan / 管理用的高级 API
function clearAll() {
  sessions.clear(); messages.clear(); messagesBySession.clear(); meta.clear(); hidden.clear(); futCache.clear(); latestUserCache.clear(); userMsgFlag.clear(); lastMsgAt.clear(); lastRole.clear(); manualStatus.clear(); agentStopAt.clear(); doneSignalAt.clear(); externalDoneAt.clear(); externalActiveAt.clear(); pendingCodexDone.clear(); codexRuntime.clear();
  scheduleSave();
}
function clearOffsets() {
  for (const k of meta.keys()) if (k.startsWith('offset:')) meta.delete(k);
  scheduleSave();
}
function resetAgent(agent) {
  for (const [k, s] of sessions) if (s.agent === agent) sessions.delete(k);
  for (const [k, m] of messages) if (m.agent === agent) deleteStoredMessage(k);
  for (const [k, h] of hidden) if (h.agent === agent) hidden.delete(k);
  for (const [k] of futCache) if (k.startsWith(agent + ':')) futCache.delete(k);
  for (const [k] of latestUserCache) if (k.startsWith(agent + ':')) latestUserCache.delete(k);
  for (const [k] of userMsgFlag) if (k.startsWith(agent + ':')) userMsgFlag.delete(k);
  for (const [k] of lastMsgAt) if (k.startsWith(agent + ':')) lastMsgAt.delete(k);
  for (const [k] of lastRole) if (k.startsWith(agent + ':')) lastRole.delete(k);
  for (const [k] of manualStatus) if (k.startsWith(agent + ':')) manualStatus.delete(k);
  for (const [k] of agentStopAt) if (k.startsWith(agent + ':')) agentStopAt.delete(k);
  for (const [k] of doneSignalAt) if (k.startsWith(agent + ':')) doneSignalAt.delete(k);
  for (const [k] of externalDoneAt) if (k.startsWith(agent + ':')) externalDoneAt.delete(k);
  for (const [k] of externalActiveAt) if (k.startsWith(agent + ':')) externalActiveAt.delete(k);
  for (const [k] of pendingCodexDone) if (k.startsWith(agent + ':')) pendingCodexDone.delete(k);
  for (const [k] of codexRuntime) if (k.startsWith(agent + ':')) codexRuntime.delete(k);
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
  latestUserCache.clear();
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
      const latest = list.findLast((m) => !!extractUserQuery(m.text));
      latestUserCache.set(ref, { text: latest.text, ts: latest.ts || 0 });
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
  setMeta: { run: (k, v) => { if (meta.get(k) === v) return; meta.set(k, v); scheduleSave(); } },
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
  zcode: { name: 'ZCode', color: '#1772F0' },
  pi: { name: 'Pi Agent', color: '#01BEBF' },
  hermes: { name: 'Hermes Agent', color: '#F59E0B' },
  other: { name: '其他', color: '#888780' },
};
function agentMeta(a) { return AGENT_META[a] || AGENT_META.other; }

function tx(fn) {
  const r = fn();
  scheduleSave();
  return r;
}

load();
process.on('beforeExit', () => {
  if (shuttingDown) return;
  shuttingDown = true;
  save();
});
const shutdown = async () => {
  shuttingDown = true;
  await save();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

module.exports = {
  ingest, touchActive, getActive, getRecentActive, getStats, getTimeline, getSession, getSessionTitle, getSessions, tx,
  matchesSessionQuery,
  agentMeta, AGENT_META, db, stmts, nowMs, extractUserQuery, smartTitle, selectSessionCardUserText,
  hideSession, unhideSession, listHidden, deleteSessionByRef,
  setManualStatus, isManuallyDone,
  setAgentActive, setAgentStopped, isLiveRef, getLastRole, resolveAgentRef, setDoneSignal, noteExternalStatus, shouldAdvanceSessionTime, isExternalCompletionActive, noteCodexActivity, confirmCodexContinuation, noteCodexThreadStatus, getRuntimeStatuses, migrateCodexCompletionSignals,
  resolveSessionControlTarget,
  clearAll, clearOffsets, resetAgent, repairSessionTimestamps, repairUserQueries,
  DATA_PATH,
};
