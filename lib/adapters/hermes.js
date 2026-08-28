'use strict';

// Hermes Agent Desktop 适配器
// 数据源：Windows %LOCALAPPDATA%\hermes\state.db；macOS ~/Library/Application Support/hermes/state.db。
// sessions 保存持久化 stored session id/title；messages.content 保存正文。
const fs = require('fs');
const path = require('path');
const os = require('os');
const { DatabaseSync } = require('node:sqlite');

const ID = 'hermes';
const ROOT = process.platform === 'darwin'
  ? path.join(os.homedir(), 'Library', 'Application Support', 'hermes')
  : path.join(os.homedir(), 'AppData', 'Local', 'hermes');
const DB = path.join(ROOT, 'state.db');
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
    const callId = String(call && call.id || '').trim();
    const fn = call && call.function;
    if (!callId || !fn || fn.name !== 'delegate_task') continue;
    const args = parseJson(fn.arguments);
    if (!args || typeof args !== 'object' || Array.isArray(args)) continue;
    const tasks = Array.isArray(args.tasks) ? args.tasks : [args];
    for (let taskIndex = 0; taskIndex < tasks.length; taskIndex++) {
      const task = tasks[taskIndex];
      const goal = shortTitle(task && task.goal);
      if (!goal) continue;
      out.push({
        callId,
        taskIndex,
        goal,
        role: shortTitle(task && task.role),
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

function parseSessionRows(session, rows) {
  const sid = String(session.id || '');
  const project = String(session.cwd || '');
  const out = [];
  const safeRows = Array.isArray(rows) ? rows : [];
  const callsById = new Map();
  for (const row of safeRows) {
    for (const call of delegationCalls(row)) {
      const calls = callsById.get(call.callId) || new Map();
      calls.set(call.taskIndex, call);
      callsById.set(call.callId, calls);
    }
  }
  const main = mainTopology(sid);

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

    for (const call of delegationCalls(row)) {
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

    for (const result of delegationResults(row)) {
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

function parseSessionStatus(session, latestMessage) {
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
    ...mainTopology(sid),
  }];
}

function openDb() {
  if (!fs.existsSync(DB)) return null;
  try {
    return new DatabaseSync(DB, { readOnly: true });
  } catch (e) {
    console.error(`[${ID}] open db failed:`, e.message);
    return null;
  }
}

function ingestSession(db, session, store, latestMessageStmt) {
  const sid = String(session.id || '');
  if (!sid || !SESSION_ID_PATTERN.test(sid)) return 0;

  // 标题每次重扫都用同一个 sourceId，标题更新时会幂等覆盖旧值。
  const titleEvents = parseSessionRows(session, []).filter((event) => event.kind === 'title');
  for (const event of titleEvents) store.ingest(event);

  const offsetKey = `offset:topology-v2:${ID}:${sid}`;
  const stored = store.stmts.getMeta.get(offsetKey)?.v;
  const lastMessageId = stored == null ? -1 : Number(stored);
  let rows;
  let latestMessage;
  try {
    latestMessage = latestMessageStmt
      ? latestMessageStmt.get(sid)
      : db.prepare('SELECT id, role, timestamp, finish_reason, tool_calls, tool_name, tool_call_id FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 1').get(sid);
    rows = db.prepare(
      `SELECT id, role, content, timestamp, finish_reason, tool_calls, tool_name, tool_call_id
       FROM messages
       WHERE session_id = ?
         AND (id > ? OR (id = ? AND role = 'assistant' AND finish_reason IS NOT NULL AND finish_reason != 'tool_calls'))
       ORDER BY id`
    ).all(sid, lastMessageId, lastMessageId);
  } catch (e) {
    console.error(`[${ID}] query messages ${sid} failed:`, e.message);
    return 0;
  }

  let count = 0;
  let maxMessageId = lastMessageId;
  for (const event of parseSessionRows(session, rows)) {
    store.ingest(event);
    if (event.kind === 'message') count++;
  }
  for (const event of parseSessionStatus(session, latestMessage)) store.ingest(event);
  for (const row of rows) {
    const id = Number(row.id);
    if (Number.isFinite(id) && id > maxMessageId) maxMessageId = id;
  }
  if (maxMessageId !== lastMessageId) store.stmts.setMeta.run(offsetKey, String(maxMessageId));
  return count;
}

function scanFromDb(store) {
  const db = openDb();
  if (!db) return 0;
  let count = 0;
  try {
    const sessions = db.prepare(
      'SELECT id, title, cwd, profile_name, ended_at, end_reason, last_activity_at FROM sessions ORDER BY started_at DESC'
    ).all();
    const latestMessageStmt = db.prepare(
      'SELECT id, role, timestamp, finish_reason, tool_calls, tool_name, tool_call_id FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT 1'
    );
    for (const session of sessions) count += ingestSession(db, session, store, latestMessageStmt);
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

module.exports = {
  ID, ROOT, DB, detect, normalizeTimestamp, parseSessionRows, parseSessionStatus,
  parseJson, delegationCalls, delegationResults, mainTopology, childTopology,
  scanAll(store) { return scanFromDb(store); },
  poll(store, changedPaths) {
    const relevant = new Set([DB, DB + '-wal', DB + '-shm'].map((p) => path.resolve(p).toLowerCase()));
    if (!(changedPaths || []).some((p) => relevant.has(path.resolve(p).toLowerCase()))) return 0;
    return scanFromDb(store);
  },
  // SQLite 数据源不存在“一个文件=一个会话”的概念。
  isSessionFile() { return false; },
};
