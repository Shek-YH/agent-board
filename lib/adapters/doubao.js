'use strict';
// 豆包适配器：通过 Python 宽松提取器解析 Electron IndexedDB (LevelDB) 里的会话
// 数据源：%LocalAppData%\Doubao\User Data\Default\IndexedDB\chrome_doubao-chat_0.indexeddb.leveldb\*.log
// 豆包会话是 V8 序列化 + UTF-16LE 混排，完整解析脆弱，用启发式提取会话骨架+用户指令文本
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawnSync } = require('child_process');

const ID = 'doubao';
const MARVIS_ROOT = path.join(os.homedir(), 'AppData', 'Local', 'Doubao');
const ROOT = path.join(MARVIS_ROOT, 'User Data', 'Default', 'IndexedDB', 'chrome_doubao-chat_0.indexeddb.leveldb');

const PYTHON = process.env.AGENTBOARD_PYTHON ||
  path.join(os.homedir(), '.workbuddy', 'binaries', 'python', 'versions', '3.13.12', 'python.exe');
const EXTRACTOR = path.join(__dirname, '..', 'doubao-extract.py');

function extract() {
  try {
    const r = spawnSync(PYTHON, [EXTRACTOR], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 30000, windowsHide: true });
    if (r.error || r.status !== 0) { console.error(`[${ID}] extract failed:`, r.stderr || r.error?.message); return []; }
    const d = JSON.parse(r.stdout || '[]');
    return Array.isArray(d) ? d : [];
  } catch (e) { console.error(`[${ID}] extract exception:`, e.message); return []; }
}

// 按会话 id 增量入库（宽松：每次全量扫描，用 offset 记录"已入库的会话数"，新会话才入库）
function scanOrPoll(store) {
  const sessions = extract();
  let count = 0;
  for (const s of sessions) {
    const key = `offset:${ID}:${s.id}`;
    const seen = store.stmts.getMeta.get(key)?.v;
    if (seen) continue;
    const title = s.title || (s.user_texts && s.user_texts[0]) || ('豆包会话 ' + String(s.id).slice(-6));
    const userText = (s.user_texts && s.user_texts[0]) || title;
    // 会话标题（kind=title，不计消息数）
    store.ingest({
      agent: ID, sourceId: `title:${s.id}`, sessionId: String(s.id),
      ts: 0, role: 'system', kind: 'title', text: '', title, project: '',
    });
    // 首条用户指令作为消息（让 has_user=true）
    if (userText) {
      store.ingest({
        agent: ID, sourceId: `msg:${s.id}:0`, sessionId: String(s.id),
        ts: Number(s.ts) || Date.now(), role: 'user', kind: 'message', text: userText, project: '',
      });
    }
    // 显式把 lastActivity 推到当前时间（与 claude/codex/deepseek poll 一致），
    // 避免 ingest 的历史 ts 推 lastActivity 让昨天的 doubao session 看起来"刚刚活跃"。
    // ts 是 leveldb position 推算的伪时间，**不能**作为 active 信号。
    store.touchActive(`${ID}:${s.id}`, { agent: ID, project: '' }, Date.now());
    // 但 doubao 桌面应用没有"现在是否在跑"的实时信号（无 heartbeat 文件）——
    // 如果用户切到 board 时刚启动 server，scanOrPoll 会把过去 24h 内所有 doubao session
    // 都标为"进行中"，这与"用户没在 doubao 操作"的现实不符。
    // 立即把 lastActivity 推到一个"刚好在 10 分钟窗口外"的时间（= ingest 后第 11 分钟），
    // 这样 session 状态稳定显示"已完成"；仅当 fs.watch 捕获到新日志写入（用户实际操作）时，
    // poll 路径会再 touchActive 才显示 active。
    store.touchActive(`${ID}:${s.id}`, { agent: ID, project: '' }, Date.now() - 11 * 60 * 1000);
    store.stmts.setMeta.run(key, '1');
    count++;
  }
  return count;
}

module.exports = {
  ID, ROOT,
  scanAll(store) { return scanOrPoll(store); },
  poll(store, changedPaths) {
    // 豆包 log 文件变更时重扫
    const hit = (changedPaths || []).some((p) => p && p.includes('chrome_doubao-chat_0.indexeddb'));
    if (!hit && changedPaths && changedPaths.length) return 0;
    return scanOrPoll(store);
  },
  isSessionFile() { return false; }, // 非文件型（SQLite/LevelDB 类）
};
