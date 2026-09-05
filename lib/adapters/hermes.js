'use strict';

// Hermes Agent Desktop 适配器
// 数据源：Windows %LOCALAPPDATA%\hermes\state.db；macOS ~/Library/Application Support/hermes/state.db。
// sessions 保存持久化 stored session id/title；messages.content 保存正文。
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { SOURCE_PATHS } = require('../source-paths');

const ID = 'hermes';
const ROOT = SOURCE_PATHS.hermes;
const DB = SOURCE_PATHS.hermesDb;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,160}$/;

function normalizeTimestamp(value) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  // Hermes state.db 当前用 Unix seconds；兼容未来直接写入毫秒的版本。
  return Math.round(n < 1e12 ? n * 1000 : n);
}

function extractText(content) {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content.map(extractText).filter(Boolean).join('\n').trim();
  }
  if (content && typeof content === 'object') return String(content.text || '').trim();
  return '';
}

function parseJson(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function mainTopology(sessionId) {
  return {
    sessionRole: 'main',
    rootSessionId: sessionId,
    topologySource: 'structural',
    topologyConfidence: 1,
    childDetection: 'verified',
    controlEligibility: 'eligible',
  };
}

function childTopology(parentSessionId, callId, taskIndex) {
  const sessionId = `${parentSessionId}:subagent:${callId}:${taskIndex}`;
  return {
    sessionId,
    sessionRole: 'child',
    parentSessionId,
    rootSessionId: parentSessionId,
    topologySource: 'explicit',
    topologyConfidence: 1,
    childDetection: 'verified',
    controlEligibility: 'blocked',
  };
}

function shortTitle(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 40);
}

function delegationCalls(row) {
  if (!row || row.role !== 'assistant') return [];
  const calls = parseJson(row.tool_calls);
  if (!Array.isArray(calls)) return [];
  const out = [];
  for (const call of calls) {
    const callId = call && typeof call.id === 'string' ? call.id.trim() : '';
    const fn = call && call.function;
    if (!callId || !fn || fn.name !== 'delegate_task') continue;
    const args = parseJson(fn.arguments);
    if (!args || typeof args !== 'object' || Array.isArray(args)) continue;
    const tasks = Array.isArray(args.tasks) ? args.tasks : [args];
    for (let taskIndex = 0; taskIndex < tasks.length; taskIndex++) {
      const task = tasks[taskIndex];
      if (!task || typeof task !== 'object' || Array.isArray(task)) continue;
      const goal = typeof task.goal === 'string' ? shortTitle(task.goal) : '';
      if (!goal) continue;
      out.push({
        callId,
        taskIndex,
        goal,
        role: typeof task.role === 'string' ? shortTitle(task.role) : '',
      });
    }
  }
  return out;
}

const TERMINAL_DELEGATE_STATUSES = new Set([
  'completed', 'success', 'succeeded', 'failed', 'failure', 'error',
  'cancelled', 'canceled', 'terminated', 'timeout', 'timed_out',
]);

function delegationResults(row) {
  if (!row || row.role !== 'tool' || row.tool_name !== 'delegate_task') return [];
  const callId = String(row.tool_call_id || '').trim();
  if (!callId) return [];
  const payload = parseJson(row.content);
  if (!payload || !Array.isArray(payload.results)) return [];
  return payload.results.flatMap((result) => {
    if (!result || typeof result !== 'object' || Array.isArray(result)) return [];
    const taskIndex = Number(result.task_index);
    if (!Number.isInteger(taskIndex) || taskIndex < 0) return [];
    const status = String(result.status || '').trim().toLowerCase();
    const summary = extractText(result.summary);
    return [{ callId, taskIndex, status, summary, terminal: TERMINAL_DELEGATE_STATUSES.has(status) }];
  });
}

function nativeChildTopology(sessionId, parentSessionId) {
  return {
    sessionId,
    sessionRole: 'child',
    parentSessionId,
    rootSessionId: parentSessionId,
    topologySource: 'explicit',
    topologyConfidence: 1,
    childDetection: 'verified',
    controlEligibility: 'blocked',
  };
}

// Hermes Desktop 的后台 fan-out 不一定把结果写成 role=tool 的 delegate_task
// payload；当前版本会把汇总以一条用户注入消息写回主会话：
// [ASYNC DELEGATION BATCH COMPLETE — <delegation_id>]。解析这条持久化消息，
// 让已经投影出的 child span 获得真实结果和 turn_end，而不是一直等 10 分钟窗口超时。
function delegationDispatch(row) {
  if (!row || row.role !== 'tool' || row.tool_name !== 'delegate_task') return null;
  const callId = String(row.tool_call_id || '').trim();
  const payload = parseJson(row.content);
  const delegationId = payload && typeof payload.delegation_id === 'string'
    ? payload.delegation_id.trim() : '';
  return callId && delegationId ? { callId, delegationId } : null;
}

function asyncDelegationResults(row) {
  if (!row || row.role !== 'user') return [];
  const text = extractText(row.content);
  const header = text.match(/\[ASYNC DELEGATION BATCH COMPLETE\s*[—-]\s*([^\]\s]+)\]/i);
  if (!header) return [];
  const delegationId = header[1].trim();
  const out = [];
  const segments = text.split(/\r?\n---\s*✓\s*TASK\s+/u).slice(1);
  for (const segment of segments) {
    const match = segment.match(/^(\d+)\s*\/\s*\d+\s*:[\s\S]*?\(status=([A-Za-z_]+)[^)]*\)[\s\S]*?---\s*\r?\n([\s\S]*)$/);
    if (!match) continue;
    const taskIndex = Number(match[1]) - 1;
    if (!Number.isInteger(taskIndex) || taskIndex < 0) continue;
    const status = String(match[2] || '').trim().toLowerCase();
    const summary = String(match[3] || '').split(/\r?\nFull live transcript\s*:/i)[0].trim();
    out.push({ delegationId, taskIndex, status, summary, terminal: TERMINAL_DELEGATE_STATUSES.has(status) });
  }
  return out;
}

function parseSessionRows(session, rows, contextRows, topologyOverride, options = {}) {
  const sid = String(session.id || '');
  const project = String(session.cwd || '');
  const out = [];
  const safeRows = Array.isArray(rows) ? rows : [];
  const callsById = new Map();
  const dispatchesById = new Map();
  const safeContextRows = Array.isArray(contextRows) ? contextRows : [];
  for (const row of [...safeContextRows, ...safeRows]) {
    for (const call of delegationCalls(row)) {
      const calls = callsById.get(call.callId) || new Map();
      calls.set(call.taskIndex, call);
      callsById.set(call.callId, calls);
    }
    const dispatch = delegationDispatch(row);
    if (dispatch) dispatchesById.set(dispatch.delegationId, dispatch.callId);
  }
  const main = topologyOverride || mainTopology(sid);
  const projectSyntheticChildren = options.suppressSyntheticChildren !== true;

  if (session.title) {
    out.push({
      agent: ID,
      sourceId: `title:${sid}`,
      sessionId: sid,
      ts: 0,
      role: 'system',
      kind: 'title',
      text: '',
      title: String(session.title).trim(),
      project,
      ...main,
    });
  }

  for (const row of safeRows) {
    const ts = normalizeTimestamp(row.timestamp);
    if (!ts) continue; // 缺失时间戳绝不使用当前时间兜底

    for (const call of projectSyntheticChildren ? delegationCalls(row) : []) {
      const topology = childTopology(sid, call.callId, call.taskIndex);
      const childSource = `${sid}:delegate:${call.callId}:${call.taskIndex}`;
      out.push({
        agent: ID, sourceId: `${childSource}:title`, sessionId: topology.sessionId,
        ts: 0, role: 'system', kind: 'title', text: '', title: call.goal, project,
        ...topology,
      });
      out.push({
        agent: ID, sourceId: `${childSource}:start`, sessionId: topology.sessionId,
        ts, role: 'user', kind: 'message', text: call.goal, project,
        ...(call.role ? { childRole: call.role } : {}), ...topology,
      });
    }

    for (const result of projectSyntheticChildren ? delegationResults(row) : []) {
      const callTasks = callsById.get(result.callId);
      const call = callTasks && callTasks.get(result.taskIndex);
      if (!call) continue; // 未知索引/未匹配调用，绝不猜测归属
      const topology = childTopology(sid, result.callId, result.taskIndex);
      const childSource = `${sid}:delegate:${result.callId}:${result.taskIndex}`;
      if (result.summary) {
        out.push({
          agent: ID, sourceId: `${childSource}:result:${row.id}`, sessionId: topology.sessionId,
          ts, role: 'assistant', kind: 'message', text: result.summary, project,
          ...topology,
        });
      }
      if (result.terminal) {
        out.push({
          agent: ID, sourceId: `${childSource}:turnend:${row.id}`, sessionId: topology.sessionId,
          ts, kind: 'turn_end', project, ...topology,
        });
      }
    }

    for (const result of projectSyntheticChildren ? asyncDelegationResults(row) : []) {
      let callId = dispatchesById.get(result.delegationId) || '';
      if (!callId && callsById.size === 1) callId = [...callsById.keys()][0];
      const callTasks = callsById.get(callId);
      const call = callTasks && callTasks.get(result.taskIndex);
      if (!call) continue; // 未知批次/索引，绝不猜测归属
      const topology = childTopology(sid, callId, result.taskIndex);
      const childSource = `${sid}:delegate:${callId}:${result.taskIndex}`;
      if (result.summary) {
        out.push({
          agent: ID, sourceId: `${childSource}:async-result:${row.id}`, sessionId: topology.sessionId,
          ts, role: 'assistant', kind: 'message', text: result.summary, project,
          ...topology,
        });
      }
      if (result.terminal) {
        out.push({
          agent: ID, sourceId: `${childSource}:async-turnend:${row.id}`, sessionId: topology.sessionId,
          ts, kind: 'turn_end', project, ...topology,
        });
      }
    }

    const role = row.role === 'user' || row.role === 'assistant' ? row.role : '';
    if (!role) continue; // tool/session_meta 不进入看板回合流
    // Hermes 用 finish_reason=tool_calls 表示还会继续执行工具；其它非空终态
    // （当前主要是 stop）表示 assistant 已把控制权交还给用户。
    const turnCompleted = role === 'assistant'
      && row.finish_reason
      && String(row.finish_reason) !== 'tool_calls';
    const text = extractText(row.content);
    if (text || role === 'user') {
      out.push({
        agent: ID,
        sourceId: String(row.id),
        sessionId: sid,
        ts,
        role,
        kind: 'message',
        text,
        project,
        ...main,
      });
    }
    if (turnCompleted) {
      out.push({
        agent: ID,
        sourceId: `${row.id}:turnend`,
        sessionId: sid,
        ts,
        kind: 'turn_end',
        project,
        ...main,
      });
    }
  }
  return out;
}

function parseSessionStatus(session, latestMessage, topologyOverride) {
  const sid = String(session.id || '');
  const endedAt = normalizeTimestamp(session.ended_at);
  if (!sid || !endedAt) return [];

  // ended_at 可能保留在同一个 stored session 上；只有它不早于最新消息时，
  // 才能把本次 session 视为终态，避免 resume 后被旧 ended_at 再次关闭。
  const latestMessageAt = normalizeTimestamp(latestMessage && latestMessage.timestamp);
  const latestActivityAt = latestMessageAt || normalizeTimestamp(session.last_activity_at);
  if (latestActivityAt > endedAt) return [];

  return [{
    agent: ID,
    sourceId: `session-end:${sid}:${endedAt}`,
    sessionId: sid,
    ts: endedAt,
    kind: 'turn_end',
    project: String(session.cwd || ''),
    ...(topologyOverride || mainTopology(sid)),
  }];
}

function openDb(dbPath = DB) {
  if (!fs.existsSync(dbPath)) return null;
  try {
    return new DatabaseSync(dbPath, { readOnly: true });
  } catch (e) {
    console.error(`[${ID}] open db failed:`, e.message);
    return null;
  }
}

function messageQueries(db) {
  const columns = new Set(db.prepare('PRAGMA table_info(messages)').all().map((row) => row.name));
  const column = (name) => columns.has(name) ? name : `NULL AS ${name}`;
  const expression = (name) => columns.has(name) ? name : 'NULL';
  const orderId = columns.has('id') ? 'id' : 'NULL';
  return {
    latest: `SELECT ${column('id')}, ${column('role')}, ${column('timestamp')}, ${column('finish_reason')}, ${column('tool_calls')}, ${column('tool_name')}, ${column('tool_call_id')}
      FROM messages WHERE ${expression('session_id')} = ? ORDER BY ${orderId} DESC LIMIT 1`,
    rows: `SELECT ${column('id')}, ${column('role')}, ${column('content')}, ${column('timestamp')}, ${column('finish_reason')}, ${column('tool_calls')}, ${column('tool_name')}, ${column('tool_call_id')}
      FROM messages
      WHERE ${expression('session_id')} = ?
        AND (id > ? OR (id = ? AND role = 'assistant' AND ${expression('finish_reason')} IS NOT NULL AND ${expression('finish_reason')} != 'tool_calls'))
      ORDER BY ${orderId}`,
    context: `SELECT ${column('id')}, ${column('role')}, ${column('tool_calls')}
      FROM messages
      WHERE ${expression('session_id')} = ? AND ${expression('role')} = 'assistant'
        AND ${expression('tool_calls')} IS NOT NULL AND ${expression('tool_calls')} != ''
      ORDER BY ${orderId}`,
  };
}

function ingestSession(
  db, session, store, latestMessageStmt, queries = messageQueries(db),
  topologyOverride = null, suppressSyntheticChildren = false,
) {
  const sid = String(session.id || '');
  if (!sid || !SESSION_ID_PATTERN.test(sid)) return 0;

  const offsetKey = `offset:topology-v2:${ID}:${sid}`;
  const stored = store.stmts.getMeta.get(offsetKey)?.v;
  const lastMessageId = stored == null ? -1 : Number(stored);
  let rows;
  let contextRows;
  let latestMessage;
  try {
    latestMessage = latestMessageStmt
      ? latestMessageStmt.get(sid)
      : db.prepare(queries.latest).get(sid);
    rows = db.prepare(queries.rows).all(sid, lastMessageId, lastMessageId);
    contextRows = db.prepare(queries.context).all(sid);
  } catch (e) {
    console.error(`[${ID}] query messages ${sid} failed:`, e.message);
    return 0;
  }

  // 升级时旧版本可能已经写入了 parent:subagent:<call>:<index> 投影；
  // 如果同一父会话现在有原生 child session，就删除这份可重建的派生卡，
  // 避免 native child 与 synthetic child 重复显示。源 Hermes 数据不受影响。
  if (suppressSyntheticChildren && typeof store.deleteSessionByRef === 'function') {
    const stale = new Set();
    for (const row of [...contextRows, ...rows]) {
      for (const call of delegationCalls(row)) {
        stale.add(`${sid}:subagent:${call.callId}:${call.taskIndex}`);
      }
    }
    for (const childId of stale) store.deleteSessionByRef(ID, childId);
  }

  // 标题每次重扫都用同一个 sourceId，标题更新时会幂等覆盖旧值。
  // 原生 child session 通常没有 sessions.title，使用它的首条 user goal 作为卡片标题。
  const sessionForRows = { ...session };
  if (topologyOverride?.sessionRole === 'child' && !sessionForRows.title) {
    const firstUser = rows.find((row) => row.role === 'user' && extractText(row.content));
    if (firstUser) sessionForRows.title = shortTitle(extractText(firstUser.content));
  }
  const titleEvents = parseSessionRows(sessionForRows, [], [], topologyOverride).filter((event) => event.kind === 'title');
  for (const event of titleEvents) store.ingest(event);

  let count = 0;
  let maxMessageId = lastMessageId;
  for (const event of parseSessionRows(sessionForRows, rows, contextRows, topologyOverride, { suppressSyntheticChildren })) {
    store.ingest(event);
    if (event.kind === 'message') count++;
  }
  for (const event of parseSessionStatus(sessionForRows, latestMessage, topologyOverride)) store.ingest(event);
  for (const row of rows) {
    const id = Number(row.id);
    if (Number.isFinite(id) && id > maxMessageId) maxMessageId = id;
  }
  if (maxMessageId !== lastMessageId) store.stmts.setMeta.run(offsetKey, String(maxMessageId));
  return count;
}

// Hermes Desktop 当前版本把 delegate child 作为独立 sessions 写入 state.db，
// 同时在 model_config._delegate_from 保留调度来源。两者同时匹配才算原生 child；
// 单独的 parent_session_id 仍可能是普通 lineage/compression 关系，不能误判。
function nativeDelegateParent(session) {
  const parent = String(session && session.parent_session_id || '').trim();
  const config = parseJson(session && session.model_config);
  const delegateFrom = config && typeof config._delegate_from === 'string'
    ? config._delegate_from.trim() : '';
  return parent && delegateFrom === parent ? parent : '';
}

function nativeSessionTopology(session) {
  const sid = String(session && session.id || '').trim();
  const parent = nativeDelegateParent(session);
  return parent ? nativeChildTopology(sid, parent) : mainTopology(sid);
}

function sessionQueries(db) {
  const columns = new Set(db.prepare('PRAGMA table_info(sessions)').all().map((row) => row.name));
  const column = (name) => columns.has(name) ? name : `NULL AS ${name}`;
  return `SELECT ${column('id')}, ${column('title')}, ${column('cwd')}, ${column('profile_name')},
    ${column('ended_at')}, ${column('end_reason')}, ${column('last_activity_at')}, ${column('started_at')},
    ${column('parent_session_id')}, ${column('model_config')}
    FROM sessions ORDER BY ${columns.has('started_at') ? 'started_at' : 'rowid'} DESC`;
}

function scanFromDb(store, dbPath = DB, { cutoff = 0 } = {}) {
  const db = openDb(dbPath);
  if (!db) return 0;
  let count = 0;
  try {
    const sessions = db.prepare(sessionQueries(db)).all();
    const queries = messageQueries(db);
    const latestMessageStmt = db.prepare(queries.latest);
    const nativeChildParents = new Set(
      sessions.map(nativeDelegateParent).filter(Boolean),
    );
    for (const session of sessions) {
      const activityAt = Math.max(
        normalizeTimestamp(session.last_activity_at),
        normalizeTimestamp(session.started_at),
      );
      if (cutoff > 0 && activityAt > 0 && activityAt < cutoff) continue;
      const topology = nativeSessionTopology(session);
      const suppressSyntheticChildren = topology.sessionRole === 'main' && nativeChildParents.has(String(session.id || ''));
      count += ingestSession(
        db, session, store, latestMessageStmt, queries, topology, suppressSyntheticChildren,
      );
    }
  } catch (e) {
    console.error(`[${ID}] scan failed:`, e.message);
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
  return count;
}

const detect = {
  tier: 'gui',
  identityGuard: { description: 'Hermes Agent 官方桌面端', notToConfuseWith: [] },
  requirements: { node: '>=22.0.0' },
  probe: { kind: 'path', win32: [DB], darwin: [DB], linux: [DB] },
  install: {
    methods: [{ kind: 'download', url: 'https://github.com/NousResearch/hermes-agent' }],
    warning: '请使用 Nous Research 官方 Hermes Desktop 安装器；看板不会修改 Hermes 数据库。',
  },
  network: { testUrls: ['https://github.com/NousResearch/hermes-agent'], mirrors: {}, blockedRegions: {} },
};

// Hermes 当前已验证会话定位、窗口接管和消息投递，但尚未发现可安全读写
// 当前 session 模型/推理配置的稳定接口。先声明真实的能力边界，让通用路由
// 保留基础托管，同时跳过未经验证的模型切换。
function createRoutingCapability() {
  return Object.freeze({ name: ID, supportsReasoning: false, routingMode: 'prompt-only' });
}

module.exports = {
  ID, ROOT, DB, detect, normalizeTimestamp, parseSessionRows, parseSessionStatus,
  parseJson, delegationCalls, delegationResults, mainTopology, childTopology,
  createRoutingCapability,
  messageQueries,
  scanDb(dbPath, store, options = {}) { return scanFromDb(store, dbPath, options); },
  scanAll(store, options = {}) { return scanFromDb(store, DB, options); },
  poll(store, changedPaths) {
    const relevant = new Set([DB, DB + '-wal', DB + '-shm'].map((p) => path.resolve(p).toLowerCase()));
    if (!(changedPaths || []).some((p) => relevant.has(path.resolve(p).toLowerCase()))) return 0;
    return scanFromDb(store);
  },
  // SQLite 数据源不存在“一个文件=一个会话”的概念。
  isSessionFile() { return false; },
};
