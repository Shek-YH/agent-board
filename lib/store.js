'use strict';
// 存储层：JSON 快照 + 内存索引
// 原 SQLite 方案在 Node 22 + 360 环境下会被误判锁定，
// 改用 JSON 文件持久化，运行时全量加载到内存，避免数据库文件被安全软件拦截。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const codexStatus = require('./codex-status');
const { getDataDir } = require('./runtime-paths');
const {
  normalizeTopologyMessage,
  mergeTopology,
  summarizeTopology,
  resolveControlTarget: resolveTopologyControlTarget,
} = require('./session-topology');
const { createTodoService } = require('./todo-service');
const { createPromptService } = require('./prompt-service');
const { createIndexService } = require('./index-service');
const { createJsonSnapshotStore } = require('./storage/json-snapshot-store');
const { createRuntimeStore } = require('./session-lifecycle/runtime-store');
const { createStateEngineStoreBridge } = require('./state-engine/store-bridge');
const { buildStatusDiagnostics, buildDiagnosticBundle } = require('./state-engine/diagnostics');
const { replayLifecycleSnapshot } = require('./session-lifecycle/replay');
const {
  applyStoreMessage,
  applyExternalStatus,
  applyHeartbeat,
  applyManualCompletion,
  applyCompletionConfirmed,
  applyWorkBuddyRuntimeStatus,
} = require('./session-lifecycle/adapter-bridge');
const {
  createUserDataStore,
  emptySnapshot: emptyUserSnapshot,
  normalizeSnapshot: normalizeUserSnapshot,
  mergeSnapshots,
  countAll: countUserItems,
} = require('./user-data-store');

const DATA_DIR = getDataDir();
const DATA_PATH = path.join(DATA_DIR, 'data.json');
const snapshotStorage = createJsonSnapshotStore({
  filePath: DATA_PATH,
  backupDir: path.join(DATA_DIR, 'migration-backups'),
});
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// 用户创作数据（待办 / 提示词 / 索引）走独立文件 user-data.json：
// 与 100MB+ 的会话缓存解耦，写失败/损坏/清库都不会再带走用户资产。
const userDataStore = createUserDataStore({
  dir: DATA_DIR,
  logError: (stage, err) => logSaveError(`user-data:${stage}`, err),
});

// 启动时清理残留的 data.json.*.tmp：上一次 save() rename EPERM 失败留下的孤儿文件，
// 累积会拖死磁盘（106MB × N = 几 GB）并导致后续 save 一直 ENOSPC。
// 必须在 load() 之前完成，避免 rename 时还看到旧 .tmp。
function cleanupStaleTmpFiles(dir) {
  let entries;
  try { entries = fs.readdirSync(dir); } catch { return; }
  let removed = 0, freed = 0;
  for (const name of entries) {
    if (!name.startsWith('data.json.') || !name.endsWith('.tmp')) continue;
    const p = path.join(dir, name);
    try {
      const st = fs.statSync(p);
      fs.unlinkSync(p);
      removed += 1;
      freed += st.size;
    } catch { /* 文件可能被其他进程持有，跳过 */ }
  }
  if (removed > 0) console.log(`[store] 清理 ${removed} 个残留 .tmp，释放 ${(freed / 1024 / 1024).toFixed(1)} MB`);
}
cleanupStaleTmpFiles(DATA_DIR);

// 内存数据结构
const sessions = new Map();   // id -> session
const messages = new Map();   // "agent:source_id" -> message
const messagesBySession = new Map(); // ref -> ("agent:source_id" -> message)，详情抽屉按 session 读取
const meta = new Map();       // k -> v
const hidden = new Map();     // "agent:session_id" -> { agent, session_id, at }
const todoTasks = new Map();  // id -> global todo task
const promptGroups = new Map(); // id -> prompt group
const prompts = new Map();      // id -> prompt
const indexEntries = new Map(); // id -> index entry
let indexCategoryOrder = [];    // ordered category names
const activeMap = new Map();  // ref -> { agent, project, title, lastActivity }；Codex 用日志写入时间维持长工具调用期间的活跃态
const lastMsgAt = new Map();  // ref -> ts  每会话「最后一条真实消息」时间（kind!=heartbeat/title）——无外部状态时的活跃依据
const lastRole = new Map();   // ref -> 'user'|'assistant'  每会话最后一条真实消息的角色（桌面会话停顿检测用：agent 停笔 = 最后一条是 assistant）
const manualStatus = new Map(); // ref -> 'done'  手动标记为已完成（覆盖自动判定，同时跳过心跳跟踪）；无条目 = 自动判定
const agentStopAt = new Map(); // ref -> ts  agent 心跳停止时刻（内存态，不持久化）——提前结束「进行中」的辅助信号
const doneSignalAt = new Map(); // ref -> ts  agent 主动完成信号（/api/complete，持久化）——agent 明确声明本轮已结束；
                               // 只有「晚于信号时刻的新真实消息」才能解除，进程检查/心跳/停顿检测均不可覆盖
const externalDoneAt = new Map(); // ref -> WorkBuddy 外部数据库终态时间（内存态）——心跳和停顿检测不可覆盖
const externalActiveAt = new Map(); // ref -> WorkBuddy 外部数据库 active 状态时间（内存态）——允许长时间运行会话保持 active
// 外部数据库（workbuddy.db）已确认的终态集合；一旦 externalDoneAt 命中，monitor 卡住的
// waiting_user_input / running 等「非终态」都要让位给 completed（见 getWorkBuddyRuntimeStatus）。
const EXTERNAL_TERMINAL_STATES = new Set(['completed', 'failed', 'terminated', 'error', 'cancelled', 'canceled']);
const heartbeatActiveAt = new Map(); // ref -> 最近一次新鲜心跳的本地观察时刻（内存态）
const workbuddyRuntime = new Map(); // ref -> WorkBuddy 官方 hook 生命周期状态（内存态，重启后由 spool 重放重建）
const pendingCodexDone = new Map(); // ref -> { signalTs, dueAt } Codex task_complete 的 60 秒观察期（内存态）
const codexRuntime = new Map(); // ref -> Codex thread/turn runtime state（从 JSONL 生命周期事件归并）
const futCache = new Map();   // ref -> { text, ts } 每个会话最早的用户消息（避免 O(N*M) 遍历）
const latestUserCache = new Map(); // ref -> { text, ts } 每个会话最近的真实用户消息
const userMsgFlag = new Map(); // ref -> true  会话内存在真实用户指令（过滤系统注入后仍有内容）
const messageIngestListeners = new Set();
// Codex/WorkBuddy 的标准生命周期镜像；旧 Map 暂保留作为兼容投影，迁移完成后再收敛读取方。
const lifecycleRuntime = createRuntimeStore({ stabilizationMs: 5000 });
// V2 默认 off；shadow/on 只旁路读取 Codex 结构化事件，旧状态 Map/API 保持兼容。
const stateEngineBridge = createStateEngineStoreBridge({
  persistencePath: path.join(DATA_DIR, 'state-engine-v2.json'),
});

let saveTimer = null;
let saveInFlight = null;
let saveAgain = false;
let shuttingDown = false;
let persistenceSuppressed = 0;
let persistenceRevision = 0;
let savedRevision = 0;
// 防空覆盖防线：load() 成功解析过磁盘数据才置 true。
// load 失败（文件损坏/截断）时内存为空，若进程退出前 save() 会把空快照
// 覆盖掉磁盘上的有效 data.json——这正是 2026-09-06 事故（106MB 变 192B）的成因。
let dataLoadedOk = false;
let lastPrevBackupAt = 0;
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

function onMessageIngested(listener) {
  if (typeof listener !== 'function') throw new TypeError('message ingest listener must be a function');
  messageIngestListeners.add(listener);
  return () => messageIngestListeners.delete(listener);
}

function emitMessageIngested({ agent, sessionRef, project, role, sourceId, ts }) {
  if (role !== 'assistant') return;
  const messageId = sourceId
    ? crypto.createHash('sha256').update(String(sourceId), 'utf8').digest('hex').slice(0, 32)
    : '';
  const event = {
    agent: String(agent || ''), sessionRef: String(sessionRef || ''), project: String(project || ''),
    role: 'assistant', messageId, messageAt: Number.isFinite(Number(ts)) ? Number(ts) : null,
  };
  for (const listener of messageIngestListeners) {
    try { listener(event); } catch (error) {
      const code = typeof (error && error.code) === 'string' && /^[A-Z0-9_]{1,60}$/.test(error.code)
        ? error.code : 'INGEST_LISTENER_FAILED';
      console.error('[store] message ingest listener failed:', code);
    }
  }
}

function deleteStoredMessage(key) {
  const message = messages.get(key);
  if (!message) return;
  messages.delete(key);
  removeIndexedMessage(key, message);
}

function load() {
  lifecycleRuntime.clear();
  const loadUserData = (legacy) => {
    try { applyUserSnapshot(resolveUserSnapshot(legacy)); userDataLoadedAt = Date.now(); }
    catch (e) { console.error('[store] user data load failed:', e.message); }
  };
  // 全新安装 / 重装后 data.json 尚不存在，或随后被删除：
  // 会话缓存可以为空，但独立的用户数据（待办/提示词/索引）必须照常加载。
  if (!fs.existsSync(DATA_PATH)) { loadUserData(null); return; }
  try {
    const data = snapshotStorage.load();
    dataLoadedOk = true;
    sessions.clear(); messages.clear(); messagesBySession.clear(); meta.clear(); hidden.clear(); todoTasks.clear(); promptGroups.clear(); prompts.clear(); indexEntries.clear(); indexCategoryOrder = []; futCache.clear(); latestUserCache.clear(); userMsgFlag.clear(); lastMsgAt.clear(); lastRole.clear(); manualStatus.clear(); agentStopAt.clear(); doneSignalAt.clear(); externalDoneAt.clear(); externalActiveAt.clear(); heartbeatActiveAt.clear(); workbuddyRuntime.clear(); pendingCodexDone.clear(); codexRuntime.clear(); turnEndSeen.clear();
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
    loadUserData(data);
    for (const m of data.manualStatus || []) if (m && m.ref && m.status) manualStatus.set(m.ref, m.status);
    for (const a of data.agentStopAt || []) if (a && a.ref && a.ts) agentStopAt.set(a.ref, a.ts);
    for (const d of data.doneSignalAt || []) if (d && d.ref && d.ts) doneSignalAt.set(d.ref, d.ts);
    for (const [ref, info] of lastRoleInfo) lastRole.set(ref, info.role);
    migrateWorkBuddyMessageCompletions();
    replayLifecycleSnapshot(lifecycleRuntime, {
      sessions: [...sessions.values()],
      manualStatus: [...manualStatus.entries()].map(([ref, status]) => ({ ref, status })),
      doneSignalAt: [...doneSignalAt.entries()].map(([ref, ts]) => ({ ref, ts })),
    });
  } catch (e) {
    console.error('[store] load failed:', e.message);
    // 会话缓存损坏（截断/JSON 错误）也不影响用户资产：从独立文件重新加载
    loadUserData(null);
  }
}

function save() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (saveInFlight) {
    saveAgain = true;
    return saveInFlight;
  }
  const snapshotRevision = persistenceRevision;
  const data = {
    sessions: [...sessions.values()],
    messages: [...messages.values()],
    meta: [...meta.entries()].map(([k, v]) => ({ k, v })),
    hidden: [...hidden.values()],
    todoTasks: [...todoTasks.values()],
    promptGroups: [...promptGroups.values()],
    prompts: [...prompts.values()],
    indexEntries: [...indexEntries.values()],
    indexCategoryOrder: [...indexCategoryOrder],
    manualStatus: [...manualStatus.entries()].map(([ref, status]) => ({ ref, status })),
    agentStopAt: [...agentStopAt.entries()].map(([ref, ts]) => ({ ref, ts })),
    doneSignalAt: [...doneSignalAt.entries()].map(([ref, ts]) => ({ ref, ts })),
  };
  const json = JSON.stringify(data);
  // ---- 防空覆盖防线 ----
  // load() 从未成功（data.json 损坏）且内存空、磁盘却已有大文件时，
  // 拒绝用空快照覆盖。防止 beforeExit/定时器触发 save() 时清空有效数据。
  if (!dataLoadedOk && sessions.size === 0 && messages.size === 0) {
    try {
      const existing = fs.statSync(DATA_PATH);
      if (existing.size > 1024) {
        console.error(`[store] 拒绝空快照覆盖：磁盘 data.json ${existing.size}B，但内存为空（load 失败？）`);
        logSaveError('guard', new Error(`拒绝空快照覆盖 ${existing.size}B`));
        if (saveAgain) saveAgain = false;
        return Promise.resolve();
      }
    } catch { /* 磁盘无文件或不可读：允许写 */ }
  }
  // ---- 滚动备份 data.json.prev（10 分钟节流）----
  // 任何覆盖事故（写坏/截断/被误覆盖）都能从 .prev 回滚。
  let prevBackup = Promise.resolve();
  const nowMsVal = Date.now();
  const shouldPrevBackup = nowMsVal - lastPrevBackupAt > 10 * 60 * 1000;
  if (shouldPrevBackup) {
    lastPrevBackupAt = nowMsVal;
    try {
      if (fs.existsSync(DATA_PATH)) {
        prevBackup = fs.promises.copyFile(DATA_PATH, `${DATA_PATH}.prev`).catch(() => {});
      }
    } catch { /* 备份失败不阻断主保存 */ }
  }
  // 使用进程独立的临时文件，避免两个 Agent Board 版本同时运行时互相删临时文件。
  // 写盘和回退都走 Promise，不能让 80MB 快照阻塞 HTTP 事件循环。
  saveInFlight = prevBackup
    .then(() => snapshotStorage.saveAsync(data, { backup: false }))
    .catch((error) => {
      logSaveError('rename', error);
      return fs.promises.writeFile(DATA_PATH, json, 'utf-8')
        .catch((fallbackError) => logSaveError('inplace', fallbackError));
    })
    .finally(() => {
      saveInFlight = null;
      savedRevision = Math.max(savedRevision, snapshotRevision);
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
  persistenceRevision++;
  if (persistenceSuppressed > 0) return;
  if (saveTimer) return;
  saveTimer = setTimeout(save, SAVE_DELAY_MS);
}

// ---------- 用户创作数据（待办 / 提示词 / 索引）独立持久化 ----------
const USER_SAVE_DELAY_MS = 300;
let userSaveTimer = null;
let userSaveInFlight = null;
let userSaveAgain = false;
let userDataLoadedAt = 0;

function collectUserSnapshot() {
  return {
    todoTasks: [...todoTasks.values()],
    promptGroups: [...promptGroups.values()],
    prompts: [...prompts.values()],
    indexEntries: [...indexEntries.values()],
    indexCategoryOrder: [...indexCategoryOrder],
  };
}

// 权威源 = user-data.json；文件不存在时（老用户升级）从旧 data.json 迁移一次
function resolveUserSnapshot(legacy) {
  const { data, source } = userDataStore.load();
  if (source !== 'none') return data;
  const migrated = normalizeUserSnapshot(legacy || {});
  if (countUserItems(migrated) > 0) {
    // 异步落盘，不阻塞启动
    void userDataStore.save(migrated).catch((error) => logSaveError('user-data:migrate', error));
    console.log(`[store] 已迁移用户数据到 ${userDataStore.filePath}（待办 ${migrated.todoTasks.length} / 提示词 ${migrated.prompts.length} / 索引 ${migrated.indexEntries.length}）`);
  }
  return migrated;
}

function applyUserSnapshot(snapshot) {
  todoTasks.clear();
  promptGroups.clear();
  prompts.clear();
  indexEntries.clear();
  indexCategoryOrder = [];
  if (!snapshot) return;
  for (const task of snapshot.todoTasks || []) {
    if (!task || !task.id || !String(task.title || '').trim()) continue;
    const createdAt = task.created_at || new Date().toISOString();
    todoTasks.set(String(task.id), {
      id: String(task.id),
      project_id: null,
      parent_id: task.parent_id == null ? null : String(task.parent_id),
      title: String(task.title).trim(),
      is_completed: task.is_completed === true,
      completed_at: task.completed_at || null,
      sort_order: Number(task.sort_order) || 1,
      created_at: createdAt,
      updated_at: task.updated_at || createdAt,
    });
  }
  for (const g of snapshot.promptGroups || []) {
    if (!g || !g.id || !String(g.name || '').trim()) continue;
    const createdAt = g.created_at || new Date().toISOString();
    promptGroups.set(String(g.id), {
      id: String(g.id),
      name: String(g.name).trim(),
      sort_order: Number(g.sort_order) || 1,
      collapsed: g.collapsed === true,
      created_at: createdAt,
      updated_at: g.updated_at || createdAt,
    });
  }
  for (const p of snapshot.prompts || []) {
    if (!p || !p.id || !p.group_id) continue;
    prompts.set(String(p.id), {
      id: String(p.id),
      group_id: String(p.group_id),
      title: String(p.title || '').trim(),
      content: String(p.content || ''),
      sort_order: Number(p.sort_order) || 1,
      use_count: Number(p.use_count) || 0,
      last_used_at: p.last_used_at || null,
      created_at: p.created_at || new Date().toISOString(),
      updated_at: p.updated_at || p.created_at || new Date().toISOString(),
    });
  }
  for (const e of snapshot.indexEntries || []) {
    if (!e || !e.id || !String(e.title || '').trim()) continue;
    indexEntries.set(String(e.id), {
      id: String(e.id),
      category: String(e.category || '').trim() || '未分类',
      title: String(e.title).trim(),
      content: String(e.content || ''),
      source: e.source === 'obsidian' ? 'obsidian' : 'manual',
      sourcePath: String(e.sourcePath || ''),
      createdAt: e.createdAt || new Date().toISOString(),
      updatedAt: e.updatedAt || e.createdAt || new Date().toISOString(),
      order: Number(e.order) || 1,
    });
  }
  const order = Array.isArray(snapshot.indexCategoryOrder) ? snapshot.indexCategoryOrder : [];
  indexCategoryOrder = order.map((c) => String(c || '').trim()).filter(Boolean);
}

function scheduleUserSave() {
  if (userSaveTimer) return;
  userSaveTimer = setTimeout(() => {
    userSaveTimer = null;
    void saveUserData();
  }, USER_SAVE_DELAY_MS);
}

function saveUserData() {
  if (userSaveInFlight) {
    userSaveAgain = true;
    return userSaveInFlight;
  }
  const snapshot = collectUserSnapshot();
  userSaveInFlight = userDataStore.save(snapshot, { loadedAt: userDataLoadedAt })
    .catch((error) => logSaveError('user-data:save', error))
    .finally(() => {
      userSaveInFlight = null;
      if (userSaveAgain) {
        userSaveAgain = false;
        void saveUserData();
      }
    });
  return userSaveInFlight;
}

function saveUserDataSync() {
  try {
    if (userSaveTimer) { clearTimeout(userSaveTimer); userSaveTimer = null; }
    return userDataStore.saveSync(collectUserSnapshot(), { loadedAt: userDataLoadedAt });
  } catch (error) {
    logSaveError('user-data:sync', error);
    return null;
  }
}

function flushUserData() {
  if (userSaveTimer) { clearTimeout(userSaveTimer); userSaveTimer = null; }
  if (userSaveInFlight) {
    userSaveAgain = true;
    return userSaveInFlight;
  }
  return saveUserData();
}

// 导入备份：mode=merge（默认，按 id/更新时间合并）| replace（整体覆盖）
function importUserData(incoming, { mode = 'merge' } = {}) {
  const normalized = normalizeUserSnapshot(incoming || {});
  const next = mode === 'replace' ? normalized : mergeSnapshots(collectUserSnapshot(), normalized);
  applyUserSnapshot(next);
  userDataLoadedAt = Date.now(); // 导入后本实例内存即权威基准
  void userDataStore.save(next, { replace: mode === 'replace', loadedAt: userDataLoadedAt })
    .catch((error) => logSaveError('user-data:import', error));
  scheduleSave();
  return next;
}

function flushPersistence() {
  if (saveInFlight) {
    if (persistenceRevision > savedRevision) saveAgain = true;
    return saveInFlight;
  }
  if (!saveTimer && persistenceRevision === savedRevision) return Promise.resolve();
  return save();
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

function sessionDisplayTitle(session) {
  if (!session) return '';
  return session.title || smartTitle(userQueryForSession(session.id)) || String(session.session_id || '').slice(0, 12);
}

// 子代理消息通常只有 assistant/tool 记录，没有独立的 user 行。
// “只显示用户发起”应沿用父会话的用户发起证据，否则 Marvis/Hermes
// 这类由主会话派发的 child 会被默认看板过滤掉。
function hasUserLineage(session) {
  if (!session) return false;
  if (userMsgFlag.has(session.id)) return true;
  return session.session_role === 'child'
    && !!session.parent_session_ref
    && userMsgFlag.has(session.parent_session_ref);
}

// 「回合结束」信号去重（agent 自身格式里的显式完成标记，见 T1，各 adapter 派生）：
// 只用来防止同一底层事件（scanAll 重放 / poll 重复触发）被处理多次，不持久化——
// 重放代价只是再 set 一次 doneSignalAt（幂等），重启后丢失也无副作用。
const turnEndSeen = new Set(); // "agent:sourceId"

// 统一入库入口
function ingest(msg) {
  const ref = msg.agent + ':' + msg.sessionId;
  if (msg.agent === 'codex') stateEngineBridge.ingest(msg, { observedAt: nowMs() });
  applyStoreMessage(lifecycleRuntime, msg);
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
    else {
      // interrupted / cancelled 是"被打断"而非"完成"，卡片仍翻 done（既有语义），但不广播完成弹窗
      const aborted = msg.turnStatus === 'interrupted' || msg.turnStatus === 'cancelled';
      setDoneSignal(ref, msg.ts || nowMs(), { suppressBroadcast: aborted });
    }
    return ref;
  }
  if (msg.kind === 'turn_start') {
    if (msg.agent === 'codex') noteCodexTurnEvent(ref, msg);
    // 全量重扫会重放历史 turn_start；使用事件自身的时刻，不能把旧回合顶成当前活跃。
    touchActive(ref, { agent: msg.agent, project: msg.project || '', title: msg.title || '' }, Number(msg.ts) || 0);
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
      // 新真实消息 = 会话复活 → 撤销待广播的完成候选（通用完成事件出口的 L2）
      cancelCompletionCandidate(ref);
      const workbuddy = workbuddyRuntime.get(ref);
      if (msg.agent === 'workbuddy' && msg.role === 'user' && workbuddy && (msg.ts || 0) >= (workbuddy.lastEventAt || 0)) {
        workbuddyRuntime.delete(ref);
      }
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
    if (!existed && msg.role === 'assistant') {
      emitMessageIngested({ agent: msg.agent, sessionRef: ref, project: msg.project || s.project, role: msg.role, sourceId: msg.sourceId, ts: msg.ts });
    }
  }

  if (!isMeta) touchActive(ref, { agent: msg.agent, project: msg.project || '', title: msg.title || '' }, msg.ts);
  // L2：WorkBuddy 真实消息到达 → 撤销可能悬着的完成候选。新消息证明「stop 之后仍在跑」，
  // 立即取消候选（不等 monitor 的 stabilizationMs 计时器），杜绝误发完成音。
  // monitor.revokePending 内部会用 isWorkBuddyStillActive 二次校验，只有证据晚于 stop 才真正撤销。
  if (!isMeta && msg.agent === 'workbuddy' && (msg.ts || 0) > 0) maybeRevokeWorkBuddyPending(ref, msg.ts);
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
  const status = state ? codexStatus.toPublicCodexStatus(state, now) : {
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
  const result = manualStatus.has(ref)
    ? { ...status, state: 'completed', completedAt: status.completedAt || now }
    : status;
  return withLifecycleStatus(ref, result);
}

function cloneRuntimeStatus(status) {
  if (!status || typeof status !== 'object') return null;
  return {
    ...status,
    activeToolIds: Array.isArray(status.activeToolIds) ? [...status.activeToolIds] : [],
    activeSubagentIds: Array.isArray(status.activeSubagentIds) ? [...status.activeSubagentIds] : [],
  };
}

const LIFECYCLE_TO_RUNTIME_STATE = Object.freeze({
  UNKNOWN: 'unknown',
  IDLE: 'idle',
  ACTIVE: 'running',
  WAITING_USER: 'waiting_user_input',
  COMPLETION_CANDIDATE: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  INTERRUPTED: 'interrupted',
});

function withLifecycleStatus(ref, status) {
  const lifecycle = lifecycleRuntime.snapshot(ref);
  const state = LIFECYCLE_TO_RUNTIME_STATE[lifecycle.publicState];
  if (!state || lifecycle.publicState === 'UNKNOWN') return status;
  return {
    ...(status || {
      threadId: ref.slice(ref.indexOf(':') + 1),
      activeFlags: [],
      source: 'lifecycle_engine',
    }),
    state,
    lastEventAt: lifecycle.updatedAt || status?.lastEventAt || 0,
    lifecycle_state: lifecycle.publicState,
    lifecycle_updated_at: lifecycle.updatedAt,
  };
}

function getWorkBuddyRuntimeStatus(ref) {
  const status = cloneRuntimeStatus(workbuddyRuntime.get(ref));
  let result = status;
  if (manualStatus.has(ref) && status) {
    result = { ...status, state: 'completed', completedAt: status.completedAt || nowMs() };
  }
  // 外部数据库（workbuddy.db）已宣告终态，但 monitor 可能因 PermissionRequest / idle_prompt
  // 等事件卡在 waiting_user_input（桌面会话结束常无解除事件，或 spool 已淘汰）→ 以外部终态为准，
  // 避免「早已结束的会话」被错误显示成「待输入」。仅当 monitor 当前不是更具体的终态（如 failed）时才覆盖。
  if (status && externalDoneAt.has(ref) && !EXTERNAL_TERMINAL_STATES.has(status.state)) {
    result = { ...status, state: 'completed', completedAt: externalDoneAt.get(ref) };
  }
  return withLifecycleStatus(ref, result);
}

function noteWorkBuddyRuntimeStatus(ref, status) {
  const key = String(ref || '');
  if (!key.startsWith('workbuddy:') || !status || typeof status !== 'object') return false;
  const next = cloneRuntimeStatus({
    ...status,
    provider: 'workbuddy',
    sessionId: status.sessionId || key.slice('workbuddy:'.length),
    source: status.source || 'workbuddy_hooks',
  });
  if (!next) return false;
  if (next.lastEventType && next.lastEventAt) {
    stateEngineBridge.ingestWorkBuddy({
      event: next.lastEventType,
      event_id: `monitor:${next.sessionId}:${next.lastEventType}:${next.lastEventAt}`,
      session_id: next.sessionId,
      ts: next.lastEventAt,
      tool_use_id: next.activeToolIds?.at(-1),
      subagent_id: next.activeSubagentIds?.at(-1),
      stop_hook_active: next.lastStopHookActive,
    }, { observedAt: nowMs() });
  }
  applyWorkBuddyRuntimeStatus(lifecycleRuntime, key, next);
  const previous = workbuddyRuntime.get(key);
  if (JSON.stringify(previous || null) === JSON.stringify(next)) return false;
  workbuddyRuntime.set(key, next);
  return true;
}

function runtimeStatusFor(ref, now = nowMs()) {
  if (ref.startsWith('workbuddy:')) {
    const legacy = getWorkBuddyRuntimeStatus(ref);
    const v2 = stateEngineBridge.getStatus(ref);
    if (!v2) return legacy;
    return {
      ...legacy,
      state: v2.legacy_state,
      canonical_state: v2.canonical_state,
      ui_status: v2.ui_status,
      state_engine_mode: v2.mode,
      state_engine_source: v2.source,
      runtime_session_key: v2.runtimeSessionKey,
    };
  }
  if (ref.startsWith('codex:')) {
    const legacy = getCodexRuntimeStatus(ref, now);
    const v2 = stateEngineBridge.getStatus(ref);
    if (!v2) return legacy;
    return {
      ...legacy,
      state: v2.legacy_state,
      canonical_state: v2.canonical_state,
      ui_status: v2.ui_status,
      state_engine_mode: v2.mode,
      state_engine_source: v2.source,
      runtime_session_key: v2.runtimeSessionKey,
    };
  }
  return null;
}

function getRuntimeStatuses(now = nowMs()) {
  const statuses = {};
  const withLifecycle = (ref, status) => {
    const lifecycle = lifecycleRuntime.snapshot(ref);
    return lifecycle.publicState === 'UNKNOWN'
      ? status
      : { ...status, lifecycle_state: lifecycle.publicState, lifecycle_updated_at: lifecycle.updatedAt };
  };
  for (const [ref, session] of sessions) {
    if (session.agent === 'codex') statuses[ref] = withLifecycle(ref, runtimeStatusFor(ref, now));
  }
  for (const ref of codexRuntime.keys()) {
    if (!statuses[ref]) statuses[ref] = withLifecycle(ref, runtimeStatusFor(ref, now));
  }
  for (const ref of workbuddyRuntime.keys()) {
    if (!statuses[ref]) statuses[ref] = withLifecycle(ref, runtimeStatusFor(ref, now));
  }
  for (const [ref] of stateEngineBridge.engine.entries()) {
    if (!statuses[ref]) {
      const status = runtimeStatusFor(ref, now);
      if (status) statuses[ref] = withLifecycle(ref, status);
    }
  }
  return statuses;
}

function getStateEngineStatuses() {
  const statuses = {};
  for (const [ref] of stateEngineBridge.engine.entries()) {
    const status = stateEngineBridge.getStatus(ref);
    if (status) statuses[ref] = status;
  }
  return statuses;
}

function getStateEngineDiagnostics(ref, { bundle = false, now } = {}) {
  const runtime = stateEngineBridge.engine.get(ref);
  if (!runtime) return null;
  const builder = bundle ? buildDiagnosticBundle : buildStatusDiagnostics;
  return builder(runtime, { now, sourceHealth: stateEngineBridge.getSourceHealth() });
}

function markStateEngineSeen(ref) {
  return stateEngineBridge.engine.markSeen(ref);
}

function markStateEngineTurnDone(ref, turnId) {
  return stateEngineBridge.engine.markTurnDone(ref, turnId);
}

function closeStateEngineSession(ref) {
  return stateEngineBridge.engine.closeSession(ref);
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
  // 用源日志时刻而不是扫描时刻：全量重扫会读取旧文件，不能把历史会话批量顶成进行中。
  touchActive(ref, info, Number(sourceTs) || 0);
}

// task_started 或真实用户消息确认了 task_complete 后的新回合。
function confirmCodexContinuation(ref, sourceTs, info) {
  const ts = Number(sourceTs) || 0;
  let changed = false;
  const pending = pendingCodexDone.get(ref);
  if (pending && ts > pending.signalTs) { pendingCodexDone.delete(ref); changed = true; }
  const doneAt = doneSignalAt.get(ref) || 0;
  if (doneAt && ts > doneAt) { doneSignalAt.delete(ref); changed = true; }
  cancelCompletionCandidate(ref); // 新回合 = 会话复活 → 撤销待广播的完成候选
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
  // 进行中 = 最后一条「真实消息」距今 < 10 分钟，或存在新鲜的 Codex/WorkBuddy
  // 运行证据，且 agent 心跳未停止（停止 → 提前视为完成）。
  // 不读 activeMap——activeMap 会被心跳类 touchActive 用 now 持续顶起（WorkBuddy 关 tab 后仍保活），
  // 用它判 active 会把已结束的会话永久标成「进行中」。
  maybeExpireMsg(10 * 60 * 1000);
  const now = nowMs();
  const refs = new Set(lastMsgAt.keys());
  for (const ref of externalActiveAt.keys()) {
    if (sessions.has(ref)) refs.add(ref);
  }
  for (const ref of heartbeatActiveAt.keys()) refs.add(ref);
  for (const ref of workbuddyRuntime.keys()) refs.add(ref);
  return [...refs]
    .filter((ref) => isLiveRef(ref, now))
    .map((ref) => {
      const s = sessions.get(ref);
      const runtime = getWorkBuddyRuntimeStatus(ref);
      const lastActivity = Math.max(
        lastMsgAt.get(ref) || 0,
        externalActiveAt.get(ref) || 0,
        heartbeatActiveAt.get(ref) || 0,
        runtime?.lastEventAt || 0,
      );
      return {
        sessionRef: ref,
        agent: (s && s.agent) || 'other',
        session_role: (s && s.session_role) || 'unknown',
        project: (s && s.project) || '',
        title: (s && (s.title || smartTitle(userQueryForSession(ref)))) || '',
        session_role: (s && s.session_role) || 'unknown',
        parent_session_ref: (s && s.parent_session_ref) || null,
        lastActivity,
        runtime_status: runtimeStatusFor(ref, now),
      };
    });
}

// 「进行中」统一判定（getActive / getSessions.status / getRecentActive.live 共用）：
//   1. 最后真实消息距今 < 10 分钟；Codex/WorkBuddy 另允许最近的运行证据维持活跃
//      （分别容忍思考/工具执行间隙与桌面心跳覆盖）
//   2. 非手动标记完成
//   3. agent 心跳未停止：心跳停止（进程退出 = 任务结束）→ 提前结束「进行中」，不必等满 10 分钟窗口
//   4. 无 agent 主动完成信号（/api/complete）：agent 明确声明本轮结束 → 立即结束，且只有新消息能解除
function isLiveRef(ref, now) {
  const workbuddy = workbuddyRuntime.get(ref);
  if (workbuddy) return workbuddy.state === 'running';
  const ts = lastMsgAt.get(ref);
  const freshCodexLog = ref.startsWith('codex:') && (activeMap.get(ref)?.lastActivity || 0) >= now - 10 * 60 * 1000;
  const freshExternalStatus = externalActiveAt.has(ref);
  const freshWorkBuddyHeartbeat = ref.startsWith('workbuddy:')
    && (heartbeatActiveAt.get(ref) || 0) >= now - 5 * 60 * 1000;
  if ((!ts || ts < now - 10 * 60 * 1000) && !freshCodexLog && !freshExternalStatus && !freshWorkBuddyHeartbeat) return false;
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
function setDoneSignal(ref, ts, { suppressBroadcast = false } = {}) {
  const at = ts || nowMs();
  pendingCodexDone.delete(ref);
  doneSignalAt.set(ref, at);
  applyCompletionConfirmed(lifecycleRuntime, ref, at);
  scheduleSave();
  // 通用完成事件出口：登记完成候选（agent 级稳定窗 + 活体否决后广播）。WorkBuddy 不在窗表 → 直接跳过。
  if (!suppressBroadcast) scheduleCompletionCandidate(ref, at);
}

// WorkBuddy 自带数据库的状态信号：只接受单调前进的状态时间，且旧状态不能覆盖更晚的真实消息。
function noteExternalStatus(ref, status) {
  if (!status || !status.statusAt) return false;
  stateEngineBridge.ingestWorkBuddyDatabase({
    ...status,
    sessionId: status.sessionId || String(ref || '').replace(/^workbuddy:/, ''),
  }, { observedAt: nowMs() });
  applyExternalStatus(lifecycleRuntime, ref, status);
  const statusAt = Number(status.statusAt) || 0;
  if (status.terminal) {
    if ((lastMsgAt.get(ref) || 0) > statusAt) return false;
    const previous = externalDoneAt.get(ref) || 0;
    if (statusAt < previous) return false;
    externalActiveAt.delete(ref);
    externalDoneAt.set(ref, statusAt);
    // 通用完成事件出口：DB 终态对任意非 workbuddy agent 都算真正完成（allowStop）
    scheduleCompletionCandidate(ref, statusAt, { allowStop: true });
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
    // L2：SQLite 变 active 也是「stop 后仍在跑」的证据 → 撤销悬着的完成候选
    if (changed) {
      maybeRevokeWorkBuddyPending(ref, statusAt);
      cancelCompletionCandidate(ref); // 通用出口：变活跃 = 撤销待广播的完成候选
    }
    return changed;
  }
  return false;
}

// WorkBuddy 的交互心跳代表桌面会话进程仍存活；它只能补充 SQLite 不可读时的
// 运行证据，不能覆盖 SQLite completed 快照、显式 /api/complete 或手动完成信号。
function noteHeartbeat(ref, alive, observedAt = nowMs()) {
  const ts = Number(observedAt) || 0;
  if (!alive) {
    heartbeatActiveAt.delete(ref);
    return false;
  }
  if (!ts) return false;
  stateEngineBridge.ingestWorkBuddyHeartbeat({
    sessionId: String(ref || '').replace(/^workbuddy:/, ''),
    lastHeartbeat: ts,
  }, { observedAt: ts });
  applyHeartbeat(lifecycleRuntime, ref, true, ts);
  heartbeatActiveAt.set(ref, ts);
  setAgentActive(ref, true, ts);
  // L2：新鲜心跳 = 进程仍在跑 → 撤销悬着的完成候选（防 stop 后仍存活却误发完成音）
  maybeRevokeWorkBuddyPending(ref, ts);
  cancelCompletionCandidate(ref);
  scheduleSave();
  return true;
}

// 旧版本把 WorkBuddy 每条 assistant status=completed 都写成 doneSignalAt。
// 这些信号能通过“信号时刻等于该会话最后一条真实消息”识别，显式 /api/complete
// 通常发生在消息之后，不满足该条件，因而保留。
function migrateWorkBuddyMessageCompletions() {
  const key = 'migration:workbuddy-message-completion-v1';
  if (meta.has(key)) return false;
  let changed = false;
  for (const [ref, signalAt] of doneSignalAt) {
    if (!ref.startsWith('workbuddy:')) continue;
    if ((lastMsgAt.get(ref) || 0) === signalAt) {
      doneSignalAt.delete(ref);
      changed = true;
    }
  }
  meta.set(key, '1');
  if (changed) scheduleSave();
  return changed;
}

function workbuddyCompletionMetaKey(ref) {
  return `workbuddy:completion-notified:${String(ref || '')}`;
}

function getWorkBuddyLastNotifiedCompletionId(ref) {
  return String(meta.get(workbuddyCompletionMetaKey(ref)) || '');
}

function saveWorkBuddyLastNotifiedCompletionId(ref, completionId) {
  const key = workbuddyCompletionMetaKey(ref);
  const value = String(completionId || '');
  if (!value || meta.get(key) === value) return;
  meta.set(key, value);
  scheduleSave();
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
    cancelCompletionCandidate(ref); // 恢复活跃 = 撤销待广播的完成候选
  } else {
    const prev = agentStopAt.get(ref) || 0;
    if (ts > prev) {
      agentStopAt.set(ref, ts);
      scheduleSave();
      // 通用完成事件出口（停顿检测 / 心跳停止）：进程/停顿终态 → 任意非 workbuddy 都算完成
      scheduleCompletionCandidate(ref, ts, { allowStop: true });
    }
  }
}

// L2 反向撤销回调：由 WorkBuddy adapter 的 ensureMonitor 注册（monitor.revokePending 的薄封装）。
// store 收到新的真实活动证据（真实消息 / SQLite 变 active / 心跳新鲜）时经 maybeRevokeWorkBuddyPending
// 触发，撤销 monitor 中悬着的完成候选 → 防止「stop 之后仍在跑」的会话误发完成音。
let workbuddyRevokePending = null;
function setWorkBuddyCompletionRevoker(fn) {
  workbuddyRevokePending = typeof fn === 'function' ? fn : null;
}
function maybeRevokeWorkBuddyPending(ref, sinceTs) {
  if (!workbuddyRevokePending || !ref.startsWith('workbuddy:')) return;
  try { workbuddyRevokePending(ref, sinceTs); } catch { /* fail-open：撤销失败不阻塞 ingest */ }
}

// L1 活体否决（供 monitor confirmCompletion/revokePending 询问）：stop 之后是否仍「存活」。
// 证据与 isLiveRef 同源：真实消息 / SQLite active / 新鲜心跳。不依赖 workbuddyRuntime——
// 它由 monitor 自身回写（循环引用无意义），且桌面端无「正在生成」状态文件。
function isWorkBuddyStillActive(ref, sinceTs) {
  if (!ref.startsWith('workbuddy:')) return false;
  const ts = Number(sinceTs) || 0;
  if ((lastMsgAt.get(ref) || 0) > ts) return true;
  if ((externalActiveAt.get(ref) || 0) >= ts) return true;
  const hb = heartbeatActiveAt.get(ref) || 0;
  if (hb >= ts && hb >= nowMs() - 5 * 60 * 1000) return true;
  return false;
}

// ============ 通用完成事件出口（非 WorkBuddy agent） ============
// WorkBuddy 由 monitor 链路独占（自带 stabilization + 活体否决 + 去重游标），不经过这里。
// 其余 agent 的「完成」已收敛到 store 单一事实源——doneSignalAt（turn_end / DB 终态 / codex
// 观察窗到期）或 agentStopAt（进程退出 / 停顿检测）。在这些"完成标记"写入处登记完成候选，
// 经 agent 级稳定窗后若仍无新活动证据，才广播一次完成事件（server 接 SSE completion →
// 弹窗 + 卡片同刻点亮）。候选期间新真实消息 / SQLite 变 active / 心跳新鲜 → 取消候选（不广播）。
// 稳定窗表（turn_end / DB 终态驱动的 agent）：这类信号的 agent 在表中才广播。
// claude/pi/zcode 的 turn_end = 每轮回复结束（进程仍活着等下一轮输入），若按 turn_end 弹
// "已完成"会复刻 WorkBuddy 误报 bug → 它们的完成事件只走「进程退出/agentStopAt」触发（见下），
// 不在本表 → setDoneSignal(turn_end) 不广播，卡片完成仍由既有 active 迁移路径负责。
const AGENT_COMPLETION_STABILIZE_MS = Object.freeze({
  codex: 0,       // 已有 pendingCodexDone 观察窗（5-60s），到期才 setDoneSignal，无需二次稳定
  marvis: 3000,   // DB 会话终态字段较权威，短窗
  hermes: 3000,   // sessions.ended_at 权威，短窗
  deepseek: 4000, // 停顿检测已带 20s debounce，再补短窗
});
// 进程退出/终态触发（setAgentStopped / setAgentActive(false) / noteExternalStatus terminal）：
// 任意非 workbuddy agent 都允许，未在稳定窗表的用此兜底窗。
const AGENT_STOP_COMPLETION_MS = 3000;
let agentStopCompletionMs = AGENT_STOP_COMPLETION_MS; // 可被测试改写
function setCompletionStopWindowMs(ms) {
  agentStopCompletionMs = Math.max(0, Number(ms) || 0);
}
const completionListeners = new Set();
const completionCandidates = new Map(); // ref -> { key, completedAt, timer }
const completionBroadcastKeys = new Map(); // ref -> 最近已广播 key（防重复广播）
let completionStabilizeOverride = null; // { agent, ms } 测试注入

function onAgentCompletion(listener) {
  if (typeof listener === 'function') completionListeners.add(listener);
  return () => { completionListeners.delete(listener); };
}
// 测试用：临时改写某 agent 的稳定窗（0 = 立即确认）
function setCompletionStabilizeMs(agent, ms) {
  completionStabilizeOverride = { agent: String(agent || ''), ms: Math.max(0, Number(ms) || 0) };
}
function emitAgentCompletion(ev) {
  for (const listener of [...completionListeners]) {
    try { listener(ev); } catch { /* 监听失败不阻塞 store */ }
  }
}
function completionAgentWindow(agent) {
  if (completionStabilizeOverride && completionStabilizeOverride.agent === agent) return completionStabilizeOverride.ms;
  const windowMs = AGENT_COMPLETION_STABILIZE_MS[agent];
  return windowMs === undefined ? null : windowMs;
}
function completionParts(ref, { allowStop = false } = {}) {
  const str = String(ref || '');
  const idx = str.indexOf(':');
  if (idx <= 0 || str.includes(':subagent:')) return null; // child 会话不弹完成
  const agent = str.slice(0, idx);
  if (agent === 'workbuddy') return null; // WorkBuddy 由 monitor 链路独占
  const windowMs = completionAgentWindow(agent);
  // 停表触发（进程退出/停顿/DB 终态）：任意非 workbuddy 都允许，用兜底窗
  if (allowStop && windowMs === null) return { agent, sessionId: str.slice(idx + 1), stopWindow: true };
  return windowMs === null ? null : { agent, sessionId: str.slice(idx + 1), stopWindow: false };
}
function cancelCompletionCandidate(ref) {
  const candidate = completionCandidates.get(ref);
  if (!candidate) return false;
  clearTimeout(candidate.timer);
  completionCandidates.delete(ref);
  return true;
}
// 候选之后是否仍有"新活动"证据（活体否决，泛化版）
function hasLivenessAfter(ref, ts) {
  const at = Number(ts) || 0;
  if ((lastMsgAt.get(ref) || 0) > at) return true;
  if ((externalActiveAt.get(ref) || 0) > at) return true;
  const hb = heartbeatActiveAt.get(ref) || 0;
  if (hb > at && hb >= nowMs() - 5 * 60 * 1000) return true;
  return false;
}
function completionBroadcastMetaKey(ref) {
  return `completion:broadcast:${String(ref || '')}`;
}
function scheduleCompletionCandidate(ref, completedAt, { allowStop = false } = {}) {
  const parts = completionParts(ref, { allowStop });
  if (!parts) return false;
  const at = Number(completedAt) || nowMs();
  const key = `${ref}@${Math.trunc(at)}`;
  // 去重双保险：内存键（本进程内）+ meta 持久键（跨重启——防止 scanAll 重放历史终态会话重复广播）
  if (completionBroadcastKeys.get(ref) === key) return false; // 该完成已广播过
  if (meta.get(completionBroadcastMetaKey(ref)) === key) return false;
  // 已广播过该会话、且自上次广播时刻后无任何新活动证据 → 判定为同一次完成的重复触发
  // （停顿检测 / 进程检查用 Date.now 每 tick 重登记，ts 递增会绕过 ref@ts 去重），不再登记。
  // 只有自上次广播后出现新活动（新真实消息 / 复活）才允许新一轮完成广播。
  const previousKey = completionBroadcastKeys.get(ref) || meta.get(completionBroadcastMetaKey(ref)) || '';
  if (previousKey) {
    const separator = previousKey.lastIndexOf('@');
    const previousAt = separator > 0 ? Number(previousKey.slice(separator + 1)) : 0;
    if (previousAt > 0 && !hasLivenessAfter(ref, previousAt)) return false;
  }
  const existing = completionCandidates.get(ref);
  if (existing && existing.key === key) return false; // 同一完成已在排队
  if (existing) cancelCompletionCandidate(ref); // 新一轮完成 → 重置窗口
  const windowMs = parts.stopWindow
    ? (completionStabilizeOverride && completionStabilizeOverride.agent === parts.agent ? completionStabilizeOverride.ms : agentStopCompletionMs)
    : (completionAgentWindow(parts.agent) || 0);
  const candidate = { key, completedAt: at, timer: null };
  const confirm = () => {
    if (completionCandidates.get(ref) !== candidate) return;
    completionCandidates.delete(ref);
    if (manualStatus.has(ref)) return; // 手动标完成不广播
    const session = sessions.get(ref);
    if (!session) return; // 无会话元数据不广播
    if (session.session_role === 'child') return; // 子代理会话不弹完成（不依赖 :subagent: 字面）
    if (hasLivenessAfter(ref, at)) return; // 活体否决：候选后仍有活动 → 不广播
    applyCompletionConfirmed(lifecycleRuntime, ref, at);
    completionBroadcastKeys.set(ref, key);
    if (completionBroadcastKeys.size > 5000) {
      const first = completionBroadcastKeys.keys().next().value;
      if (first) completionBroadcastKeys.delete(first);
    }
    // 持久化去重游标：重启后 scanAll 重放的历史终态会话不重复广播
    if (meta.get(completionBroadcastMetaKey(ref)) !== key) {
      meta.set(completionBroadcastMetaKey(ref), key);
      scheduleSave();
    }
    emitAgentCompletion({
      provider: parts.agent,
      agent: parts.agent,
      sessionId: parts.sessionId,
      completedAt: at,
      completionId: key,
      source: 'store_completion',
    });
  };
  candidate.timer = setTimeout(confirm, windowMs);
  if (candidate.timer && typeof candidate.timer.unref === 'function') candidate.timer.unref(); // 不让候选计时器阻止进程退出
  completionCandidates.set(ref, candidate);
  return true;
}
function cancelAllCompletionCandidates() {
  for (const candidate of completionCandidates.values()) clearTimeout(candidate.timer);
  completionCandidates.clear();
}

// 按 agent 批量设置（进程检查用）：进程全无 → 该 agent 所有窗口内 session 提前完成；
// 进程在 → 清除停止标记（可能 resume）
function setAgentStopped(agent, stopped, ts) {
  let changed = false;
  for (const [ref] of lastMsgAt) {
    if (!ref.startsWith(agent + ':')) continue;
    if (stopped) {
      const prev = agentStopAt.get(ref) || 0;
      if (ts > prev) {
        agentStopAt.set(ref, ts);
        changed = true;
        // 通用完成事件出口：进程退出对 claude/zcode（不在稳定窗表）也算真正完成 ——
        // 必须 allowStop:true，否则 completionParts 会因它们不在窗表而把候选丢掉。
        scheduleCompletionCandidate(ref, ts, { allowStop: true });
      }
    } else if (agentStopAt.delete(ref)) {
      changed = true;
      cancelCompletionCandidate(ref); // 进程恢复 = 撤销待广播的完成候选
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
  const firstQuery = userQueryForSession(ref);
  const latestQuery = latestUserQueryForSession(ref);
  return {
    ...s,
    runtime_status: runtimeStatusFor(ref),
    last_user_text: selectSessionCardUserText(s.agent, firstQuery, latestQuery).slice(0, 8000),
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
  if (onlyUser) list = list.filter(hasUserLineage);
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
      title: sessionDisplayTitle(s),
      // 手动标记 done 优先于自动判定
      status: isLiveRef(s.id, now) ? 'active' : 'done',
      runtime_status: runtimeStatusFor(s.id, now),
      manual_done: !!manualStatus.get(s.id),
      last_user_text: selectSessionCardUserText(s.agent, firstQuery, latestQuery).slice(0, 2000),
      has_user: hasUserLineage(s),
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
      session_role: s.session_role || 'unknown',
      parent_session_ref: s.parent_session_ref || null,
      lastActivity: s.last_seen,
      msgCount: s.msg_count || 0,
      // live 与 getActive 同口径：最后真实消息距今 < 10 分钟 且 心跳未停止；手动标记完成永远非 live
      live: isLiveRef(s.id, now),
      runtime_status: runtimeStatusFor(s.id, now),
      has_user: hasUserLineage(s),
      ...children,
    });
  });
}

// AI 监督器或自动托管层使用的严格目标解析：只返回明确可控的主会话，
// 不复用 resolveAgentRef 的“最近活跃”兜底，避免把指令发错到子代理或另一条主会话。
function resolveSessionControlTarget(options = {}) {
  const visible = [...sessions.values()].filter(s => !hidden.has(s.id));
  const controlVisible = visible.map((session) => ({
    ...session,
    title: sessionDisplayTitle(session),
  }));
  return resolveTopologyControlTarget(controlVisible, options);
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
  if (status === 'done') heartbeatActiveAt.delete(ref);
  if (status === 'done') applyManualCompletion(lifecycleRuntime, ref, nowMs());
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
  heartbeatActiveAt.delete(ref);
  workbuddyRuntime.delete(ref);
  for (const key of turnEndSeen) if (key.startsWith(`${ref}:`)) turnEndSeen.delete(key);
  codexRuntime.delete(ref);
  scheduleSave();
  return 1;
}

// rescan / 管理用的高级 API
function clearAll() {
  // 注意：待办 / 提示词 / 索引是用户资产，存在独立的 user-data.json，
  // 清空会话缓存（清库、重置、全量重扫）绝不连带清除它们。
  sessions.clear(); messages.clear(); messagesBySession.clear(); meta.clear(); hidden.clear(); futCache.clear(); latestUserCache.clear(); userMsgFlag.clear(); lastMsgAt.clear(); lastRole.clear(); manualStatus.clear(); agentStopAt.clear(); doneSignalAt.clear(); externalDoneAt.clear(); externalActiveAt.clear(); heartbeatActiveAt.clear(); workbuddyRuntime.clear(); pendingCodexDone.clear(); codexRuntime.clear(); turnEndSeen.clear();
  cancelAllCompletionCandidates();
  completionBroadcastKeys.clear();
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
  for (const [k] of heartbeatActiveAt) if (k.startsWith(agent + ':')) heartbeatActiveAt.delete(k);
  for (const [k] of workbuddyRuntime) if (k.startsWith(agent + ':')) workbuddyRuntime.delete(k);
  for (const [key] of turnEndSeen) if (key.startsWith(agent + ':')) turnEndSeen.delete(key);
  for (const [k] of pendingCodexDone) if (k.startsWith(agent + ':')) pendingCodexDone.delete(k);
  for (const [k] of codexRuntime) if (k.startsWith(agent + ':')) codexRuntime.delete(k);
  cancelAllCompletionCandidates();
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

const todoRepository = {
  list: () => [...todoTasks.values()],
  get: (id) => todoTasks.get(String(id)),
  insert: (task) => todoTasks.set(String(task.id), { ...task }),
  update: (id, patch) => {
    const current = todoTasks.get(String(id));
    if (!current) return;
    todoTasks.set(String(id), { ...current, ...patch });
  },
  delete: (id) => todoTasks.delete(String(id)),
};
const todoService = createTodoService({ repository: todoRepository });
function createTodoTask(data) { const result = todoService.createTask(data); scheduleSave(); scheduleUserSave(); return result; }
function updateTodoTask(id, data) { const result = todoService.updateTask(id, data); scheduleSave(); scheduleUserSave(); return result; }
function setTodoTaskCompleted(id, completed) { const result = todoService.setTaskCompleted(id, completed); scheduleSave(); scheduleUserSave(); return result; }
function deleteTodoTask(id) { const result = todoService.deleteTask(id); scheduleSave(); scheduleUserSave(); return result; }
function getTodoTasks() { return todoService.getTasks(); }
function getProjectTodoTasks() { return getTodoTasks(); }

const promptRepository = {
  listGroups: () => [...promptGroups.values()],
  getGroup: (id) => promptGroups.get(String(id)),
  insertGroup: (g) => promptGroups.set(String(g.id), { ...g }),
  updateGroup: (id, patch) => {
    const cur = promptGroups.get(String(id));
    if (!cur) return;
    promptGroups.set(String(id), { ...cur, ...patch });
  },
  deleteGroup: (id) => promptGroups.delete(String(id)),
  listPrompts: () => [...prompts.values()],
  getPrompt: (id) => prompts.get(String(id)),
  insertPrompt: (p) => prompts.set(String(p.id), { ...p }),
  updatePrompt: (id, patch) => {
    const cur = prompts.get(String(id));
    if (!cur) return;
    prompts.set(String(id), { ...cur, ...patch });
  },
  deletePrompt: (id) => prompts.delete(String(id)),
};
const promptService = createPromptService({ repository: promptRepository });
function createPromptGroup(data) { const r = promptService.createGroup(data); scheduleSave(); scheduleUserSave(); return r; }
function updatePromptGroup(id, data) { const r = promptService.updateGroup(id, data); scheduleSave(); scheduleUserSave(); return r; }
function deletePromptGroup(id) { const r = promptService.deleteGroup(id); scheduleSave(); scheduleUserSave(); return r; }
function getPromptGroups() { return promptService.getGroups(); }
function createPrompt(data) { const r = promptService.createPrompt(data); scheduleSave(); scheduleUserSave(); return r; }
function updatePrompt(id, data) { const r = promptService.updatePrompt(id, data); scheduleSave(); scheduleUserSave(); return r; }
function deletePrompt(id) { const r = promptService.deletePrompt(id); scheduleSave(); scheduleUserSave(); return r; }
function recordPromptUse(id) { const r = promptService.recordUse(id); scheduleSave(); scheduleUserSave(); return r; }
function getPrompts() { return promptService.getPrompts(); }

const indexRepository = {
  listEntries: () => [...indexEntries.values()],
  getEntry: (id) => indexEntries.get(String(id)),
  insertEntry: (e) => indexEntries.set(String(e.id), { ...e }),
  updateEntry: (id, patch) => {
    const cur = indexEntries.get(String(id));
    if (!cur) return;
    indexEntries.set(String(id), { ...cur, ...patch });
  },
  deleteEntry: (id) => indexEntries.delete(String(id)),
  getCategoryOrder: () => indexCategoryOrder,
  setCategoryOrder: (order) => { indexCategoryOrder = Array.isArray(order) ? order.slice() : []; },
};
const indexService = createIndexService({ repository: indexRepository });
function createIndexEntry(data) { const r = indexService.createEntry(data); scheduleSave(); scheduleUserSave(); return r; }
function updateIndexEntry(id, data) { const r = indexService.updateEntry(id, data); scheduleSave(); scheduleUserSave(); return r; }
function deleteIndexEntry(id) { const r = indexService.deleteEntry(id); scheduleSave(); scheduleUserSave(); return r; }
function reorderIndexEntries(orderedIds) { const r = indexService.reorderEntries(orderedIds); scheduleSave(); scheduleUserSave(); return r; }
function setIndexCategoryOrder(order) { const r = indexService.setCategoryOrder(order); scheduleSave(); scheduleUserSave(); return r; }
function getIndexEntries() { return indexService.getEntries(); }
function getIndexCategoryOrder() { return indexService.getCategoryOrder(); }

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

function tx(fn, { persist = true } = {}) {
  if (!persist) persistenceSuppressed++;
  try {
    return fn();
  } finally {
    if (!persist) persistenceSuppressed--;
    else scheduleSave();
  }
}

load();
process.on('beforeExit', () => {
  if (shuttingDown) return;
  shuttingDown = true;
  saveUserDataSync();
  save();
});
const shutdown = async () => {
  shuttingDown = true;
  saveUserDataSync();
  await save();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

module.exports = {
  ingest, onMessageIngested, touchActive, getActive, getRecentActive, getStats, getTimeline, getSession, getSessionTitle, getSessions, tx,
  matchesSessionQuery,
  agentMeta, AGENT_META, db, stmts, nowMs, extractUserQuery, smartTitle, selectSessionCardUserText,
  hideSession, unhideSession, listHidden, deleteSessionByRef,
  setManualStatus, isManuallyDone,
  setAgentActive, setAgentStopped, isLiveRef, getLastRole, resolveAgentRef, setDoneSignal, noteExternalStatus, noteWorkBuddyRuntimeStatus, getWorkBuddyRuntimeStatus, isWorkBuddyStillActive, setWorkBuddyCompletionRevoker, onAgentCompletion, setCompletionStabilizeMs, setCompletionStopWindowMs, cancelAllCompletionCandidates, getWorkBuddyLastNotifiedCompletionId, saveWorkBuddyLastNotifiedCompletionId, shouldAdvanceSessionTime, isExternalCompletionActive, noteCodexActivity, confirmCodexContinuation, noteCodexThreadStatus, getRuntimeStatuses, migrateCodexCompletionSignals,
  resolveSessionControlTarget, noteHeartbeat,
  createTodoTask, updateTodoTask, setTodoTaskCompleted, deleteTodoTask, getTodoTasks, getProjectTodoTasks,
  createPromptGroup, updatePromptGroup, deletePromptGroup, getPromptGroups,
  createPrompt, updatePrompt, deletePrompt, recordPromptUse, getPrompts,
  createIndexEntry, updateIndexEntry, deleteIndexEntry, reorderIndexEntries, setIndexCategoryOrder, getIndexEntries, getIndexCategoryOrder,
  getStateEngineStatuses,
  getStateEngineDiagnostics,
  markStateEngineSeen, markStateEngineTurnDone, closeStateEngineSession,
  getUserSnapshot: collectUserSnapshot, importUserData, flushUserData, saveUserDataSync,
  getLifecycleRuntimeStatuses: () => Object.fromEntries(lifecycleRuntime.entries()),
  userDataPath: userDataStore.filePath,
  flushPersistence,
  clearAll, clearOffsets, resetAgent, repairSessionTimestamps, repairUserQueries,
  DATA_PATH,
};
