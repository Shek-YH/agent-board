'use strict';
// Codex 适配器：解析 ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
// 兼容两代格式：
//   老 CLI: {timestamp, type:'user_message'|'agent_message'|'summary', payload:{text}}
//   新 Desktop(v0.14x+): {timestamp, type:'response_item', payload:{type:'message', role, content:[{type:'input_text'|'output_text', text}]}}
const path = require('path');
const os = require('os');
const { collectFiles, readAll, tailRead } = require('../watcher');

const ID = 'codex';
const ROOT = path.join(os.homedir(), '.codex', 'sessions');

function isSessionFile(p) { return p.endsWith('.jsonl'); }

// 每个 rollout 文件 = 一个会话，直接用文件名做 sessionId（跨版本最稳定）
function sessionIdFromPath(p) {
  return path.basename(p).replace(/\.jsonl$/, '').replace(/^rollout-/, '');
}

function extractPayloadText(pl) {
  if (!pl || typeof pl !== 'object') return '';
  if (typeof pl.text === 'string' && pl.text.trim()) return pl.text.trim();
  if (typeof pl.message === 'string') return pl.message.trim();
  if (typeof pl.summary === 'string') return pl.summary.trim();
  if (typeof pl.command === 'string') return '› ' + pl.command.trim();
  return '';
}

// 新格式 content 数组（与 WorkBuddy 同构）
function extractContentText(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const c of content) {
    if (!c || typeof c !== 'object') continue;
    if ((c.type === 'input_text' || c.type === 'output_text' || c.type === 'text') && c.text) {
      parts.push(c.text);
    }
  }
  return parts.join('\n').trim();
}

function parseLines(lines, filePath) {
  const out = [];
  const sid = sessionIdFromPath(filePath);
  lines.forEach((line, idx) => {
    try {
      const t = line.type;
      const pl = line.payload || {};
      const ts = Date.parse(line.timestamp); // 缺失/非法 → NaN，消息行会跳过（不误标今天）

      if (t === 'session_meta' && pl.cwd) {
        out.push({ agent: ID, sourceId: `${sid}:meta`, sessionId: sid, ts: ts || 0, role: 'system', kind: 'heartbeat', text: '', project: pl.cwd || '' });
        return;
      }
      if (!ts) return; // 消息行必须有时戳
      // 老格式
      if (t === 'user_message') {
        const text = extractPayloadText(pl);
        if (text) out.push({ agent: ID, sourceId: `${sid}:${ts}:${idx}:u`, sessionId: sid, ts, role: 'user', kind: 'message', text, project: pl.cwd || '' });
        return;
      }
      if (t === 'agent_message') {
        const text = extractPayloadText(pl);
        if (text) out.push({ agent: ID, sourceId: `${sid}:${ts}:${idx}:a`, sessionId: sid, ts, role: 'assistant', kind: 'message', text, project: pl.cwd || '' });
        return;
      }
      if (t === 'summary') {
        const text = extractPayloadText(pl);
        if (text) out.push({ agent: ID, sourceId: `${sid}:${ts}:${idx}:s`, sessionId: sid, ts, role: 'assistant', kind: 'summary', text, project: pl.cwd || '' });
        return;
      }
      // 新格式：response_item 内嵌 message
      if (t === 'response_item' && pl.type === 'message') {
        const role = pl.role;
        if (role !== 'user' && role !== 'assistant') return; // developer/system 系统上下文跳过
        const text = extractContentText(pl.content);
        if (!text) return;
        out.push({
          agent: ID, sourceId: `${sid}:${pl.id || ts}:${idx}`,
          sessionId: sid, ts, role, kind: 'message', text, project: pl.cwd || '',
        });
      }
    } catch { /* skip */ }
  });
  return out;
}

module.exports = {
  ID, ROOT, isSessionFile, parseLines, fileToSessionId: sessionIdFromPath,
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
    for (const f of changedPaths.filter(isSessionFile)) {
      const key = `offset:${ID}:${f}`;
      const offset = Number(store.stmts.getMeta.get(key)?.v || 0);
      const { lines, newOffset } = tailRead(f, offset);
      if (lines.length) {
        const msgs = parseLines(lines, f);
        for (const m of msgs) { store.ingest(m); count++; }
        // 活跃信号用当前时间：文件在写 = agent 在运行，避免消息间隔超过窗口导致状态闪烁
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
