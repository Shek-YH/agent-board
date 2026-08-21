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
