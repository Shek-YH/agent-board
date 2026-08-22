'use strict';
// Pi Agent (earendil-works/pi-coding-agent) 适配器
// 数据源：~/.pi/agent/sessions/<escaped-cwd>/<timestamp>_<uuid>.jsonl (JSONL 追加式)
// 行结构：
//   {"type":"session","id":...,"timestamp":"ISO","cwd":"C:\\Users\\..."}  ← 会话元数据（cwd=项目路径）
//   {"type":"model_change"|"thinking_level_change",...}                  ← 忽略
//   {"type":"message","id":"496a2a72","timestamp":"ISO","message":{
//      "role":"user"|"assistant"|"toolResult",
//      "timestamp":1787333006608,                                        ← 毫秒，优先用
//      "content":[{"type":"text","text":"..."}|{"type":"thinking","thinking":"..."}|{"type":"toolCall",...}]
//   }}
const path = require('path');
const os = require('os');
const { collectFiles, readAll, tailRead } = require('../watcher');

const ID = 'pi';
const ROOT = path.join(os.homedir(), '.pi', 'agent', 'sessions');

function isSessionFile(p) { return p.endsWith('.jsonl'); }

// 文件名 <ISO时间戳>_<uuid>.jsonl → 直接取完整 basename 去扩展名（含时间戳前缀，跨会话唯一）
function fileToSessionId(file) { return path.basename(file).replace(/\.jsonl$/, ''); }

// 只取 text 正文；thinking（字段名是 thinking）/toolCall 不展示
function extractText(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const c of content) {
    if (!c || typeof c !== 'object') continue;
    if (c.type === 'text' && c.text) parts.push(String(c.text));
  }
  return parts.join('\n').trim();
}

function parseLines(lines, filePath) {
  const out = [];
  const sid = fileToSessionId(filePath);
  let project = ''; // 由本文件 session 行的 cwd 决定
  lines.forEach((line, idx) => {
    try {
      if (line.type === 'session' && line.cwd) { project = line.cwd; return; }
      if (line.type !== 'message') return;
      const m = line.message || {};
      if (!m || !m.content) return;
      // 时间戳：message.timestamp 毫秒优先；行级 ISO 兜底；缺失/非法跳过（绝不用 Date.now()）
      let ts = Number(m.timestamp);
      if (!Number.isFinite(ts) || !ts) ts = Date.parse(line.timestamp);
      if (!ts) return;
      // 回合结束显式信号：stopReason==='stop' 且本条不含 toolCall = 本轮未再调用工具，
      // 真正交还控制权（stopReason==='toolUse' 表示还会继续，非终态）。放在 !text 判断之前，
      // 因为终态消息即便没有可展示正文（纯 toolResult 收尾等罕见情况）也不能漏判。
      if (m.role === 'assistant' && m.stopReason === 'stop') {
        const hasToolCall = Array.isArray(m.content) && m.content.some((c) => c && c.type === 'toolCall');
        if (!hasToolCall) {
          out.push({ agent: ID, sourceId: `${sid}:${line.id || idx}:turnend`, sessionId: sid, ts, kind: 'turn_end' });
        }
      }
      const text = extractText(m.content);
      if (!text) return;
      // toolResult 归为 assistant（看板只有 user/assistant 两态）
      const role = m.role === 'user' ? 'user' : 'assistant';
      out.push({
        agent: ID,
        sourceId: `${sid}:${line.id || idx}`, // 会话内唯一（message.id 短 id，跨会话可能重复，加会话前缀）
        sessionId: sid, ts, role, kind: 'message', text, project,
      });
    } catch { /* skip */ }
  });
  return out;
}

module.exports = {
  ID, ROOT, isSessionFile, parseLines, fileToSessionId,
  scanAll(store) {
    const files = collectFiles(ROOT, isSessionFile);
    let count = 0;
    for (const f of files) {
      const key = `offset:${ID}:${f}`;
      const offset = Number(store.stmts.getMeta.get(key)?.v || 0);
      const { lines, newOffset } = readAll(f, offset);
      if (lines.length) {
        for (const m of parseLines(lines, f)) { store.ingest(m); count++; }
      }
      store.stmts.setMeta.run(key, String(newOffset));
    }
    return count;
  },
  poll(store, changedPaths) {
    let count = 0;
    const files = changedPaths.filter(isSessionFile);
    for (const f of files) {
      const key = `offset:${ID}:${f}`;
      const offset = Number(store.stmts.getMeta.get(key)?.v || 0);
      const { lines, newOffset } = tailRead(f, offset);
      if (lines.length) {
        const msgs = parseLines(lines, f);
        for (const m of msgs) { store.ingest(m); count++; }
        // 活跃信号：watch 触发 = 文件在写入 = Pi 正在运行，用当前时间（避免旧消息时间戳掉出窗口）
        if (msgs.length) {
          const last = msgs[msgs.length - 1];
          store.touchActive(`${ID}:${last.sessionId}`, { agent: ID, project: last.project }, Date.now());
        }
      }
      store.stmts.setMeta.run(key, String(newOffset));
    }
    return count;
  },
};
