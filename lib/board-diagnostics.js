'use strict';
// 看板卡片帧诊断（F1–F4）
//
// 背景：用户曾观察到一张「缝合卡」——标题取自会话 A 的首条用户消息、预览行取自
// 会话 B 的末条用户消息、项目为空、消息数为 1。四项字段分别来自不同来源，数据层
// 却不存在同时满足这四项的会话。事后磁盘数据完全自洽，原始那一帧已无法回放。
//
// 该现象只可能出现在「会话仍在被增量读入 / 前端尚未完成对账」的中间态。为了让下次
// 复现能留下证据而不是又一次猜测，这里提供一帧轻量快照 + 偏离基线检测 + JSONL 落盘。
//
// 设计约束：
// - 快照在 /api/board 内同步构造，绝不能引入 IO；所有写盘走异步队列。
// - 日志上限 20MB、滚动 1 份；关闭方式 AB_BOARD_DIAG=0。
// - 默认只写「可疑」帧，正常帧仅在首次出现时采样 1 次，避免刷爆磁盘。

const fs = require('fs');
const path = require('path');

const DISABLED = ['0', 'false', 'off', 'no'].includes(String(process.env.AB_BOARD_DIAG || '').trim().toLowerCase());
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_SUSPECTS_PER_FRAME = 3;

// agent → 该 agent 已见过的「字段基线」。字段发生变化 = 数据在补全，值得记录。
const baselines = new Map();
// 已写过「首次见到」记录的 session ref，保证无信号帧最多为每个会话写一次。
const seenRefs = new Set();

let logPath = '';
let queued = [];
let flushing = false;

function init(dataDir) {
  try {
    logPath = path.join(dataDir, 'board-diag.jsonl');
  } catch { logPath = ''; }
}

function serializeFrame(frame) {
  // 只记关键字段：一帧 80 张卡全量落盘会把有用的信号淹没。
  return {
    ts: frame.ts,
    source: frame.source,
    total: frame.total,
    liveRefs: frame.liveRefs,
    partial: frame.partialRefs,
    cap: frame.capRefs,
    suspicious: frame.suspicious,
  };
}

function appendLine(obj) {
  if (DISABLED || !logPath) return;
  queued.push(JSON.stringify(obj));
  if (flushing) return;
  flushing = true;
  setImmediate(flush);
}

function flush() {
  const lines = queued;
  queued = [];
  flushing = false;
  if (!lines.length || !logPath) return;
  const text = lines.join('\n') + '\n';
  fs.stat(logPath, (err, st) => {
    const rotate = !err && st.size + text.length > MAX_BYTES;
    const write = (target) => fs.appendFile(target, text, 'utf8', (e) => {
      if (e) console.error('[board-diag] 写入失败:', e.message);
    });
    if (rotate) {
      fs.rename(logPath, logPath + '.1', () => write(logPath));
    } else {
      write(logPath);
    }
  });
}

// 会话处于「读入中」还是「已补全」的判定。
// - partial：heartbeat/title 先于真实消息到达时，is_read_complete 为 false，
//   此时 session.project/msg_count/title 都可能还是初值。
// - cap    ：达到 limit 被截断的帧，条数天然不可信，单独归入 truncated 名单。
function buildFrame({ source = '', groups = {}, liveRefs = [], limit = 80 } = {}) {
  const ts = Date.now();
  // 以 session.id 去重：同一会话会同时出现在「全部」列和 agent 列。
  const universe = new Map();
  const capRefs = [];
  for (const [col, entry] of Object.entries(groups)) {
    const items = Array.isArray(entry) ? entry : (entry && entry.items) || [];
    const truncated = Array.isArray(entry) ? false : Boolean(entry && entry.truncated);
    for (const s of items) {
      if (!s || !s.id || universe.has(s.id)) continue;
      universe.set(s.id, s);
      if (truncated) capRefs.push(s.id);
    }
  }
  const total = universe.size;
  const partialRefs = [];
  const suspicious = [];
  for (const s of universe.values()) {
    const hasUser = s.has_user !== false;
    // 后端字段名是 snake_case（is_read_complete），这里统一按该字段判定。
    const partial = s.is_read_complete === false;
    if (partial && hasUser) partialRefs.push(s.id);

    // 字段基线偏离：同一会话在同一 agent 下，字段值发生「倒退」或「跳变」。
    // 典型信号 —— msg_count 从 0/1 → 真实值、project 从空 → 真实路径，
    // 说明上一帧渲染的卡片确实是半成品。
    const key = s.id;
    const prev = baselines.get(key);
    const now = {
      msg_count: Number(s.msg_count || 0),
      project: String(s.project || ''),
      title: String(s.title || ''),
    };
    if (prev && prev.msg_count !== now.msg_count) {
      const jumped = now.msg_count > prev.msg_count;
      const bigJump = prev.msg_count > 0 && now.msg_count >= prev.msg_count * 2 && now.msg_count >= 10;
      if (bigJump || (prev.msg_count <= 1 && jumped && now.msg_count >= 10)) {
        suspicious.push({
          ref: s.id,
          kind: 'msg_count_jump',
          from: prev.msg_count,
          to: now.msg_count,
          projectBefore: prev.project,
          projectAfter: now.project,
        });
      }
    }
    if (prev && !prev.project && now.project) {
      suspicious.push({ ref: s.id, kind: 'project_filled', from: '', to: now.project, msgCount: now.msg_count });
    }
    // 尚无真实消息却已被渲染成卡片 —— 最接近截图那张「1 条 + 空项目」的形态。
    // 注意：此处不能要求 has_user，因为 heartbeat-only 的会话本来就还没有用户证据，
    // 而那恰恰是最该记录的一帧。
    if (partial && Number(s.msg_count || 0) <= 1 && !String(s.project || '').trim()) {
      suspicious.push({
        ref: s.id,
        kind: 'partial_card_rendered',
        msgCount: Number(s.msg_count || 0),
        hasUser: hasUser,
        title: now.title.slice(0, 40),
      });
    }
    baselines.set(key, now);
  }

  return {
    ts, source, total,
    liveRefs: liveRefs.length,
    partialRefs: partialRefs.slice(0, 20),
    capRefs: capRefs.slice(0, 10),
    suspicious: suspicious.slice(0, MAX_SUSPECTS_PER_FRAME),
    _firstSeenFor: universe,
  };
}

// 由 server.js 在 /api/board 内调用；内部决定是否落盘。
function record(frame) {
  if (DISABLED || !frame) return;
  const hasSignal = frame.suspicious.length > 0;
  // 无信号帧：为每个 session 落一次「首次见到」记录，之后不再写。
  // 注意：这里的每次 return 都必须经过 appendLine，否则 setImmediate(flush)
  // 永远不会被排上，攒在队列里的行会一直不落盘。
  const unseen = [];
  if (!hasSignal) {
    for (const [ref, s] of frame._firstSeenFor || []) {
      const k = 'seen:' + ref;
      if (seenRefs.has(k)) continue;
      seenRefs.add(k);
      unseen.push({
        ref,
        msg_count: Number(s.msg_count || 0),
        project: String(s.project || ''),
        partial: s.is_read_complete === false,
      });
      if (unseen.length >= 5) break;
    }
    if (!unseen.length) return;
  }
  appendLine(unseen.length
    ? { ...serializeFrame(frame), firstSight: unseen }
    : serializeFrame(frame));
}

// 测试/退出前强制落盘。生产路径无需调用——appendLine 已用 setImmediate 排程。
function flushNow() {
  return new Promise((resolve) => {
    if (!queued.length) { setImmediate(resolve); return; }
    flush();
    setImmediate(resolve);
  });
}

module.exports = { init, buildFrame, record, flushNow, DISABLED, logPath: () => logPath };
