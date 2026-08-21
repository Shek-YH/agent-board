'use strict';
// WorkBuddy 适配器：解析 ~/.workbuddy/projects/<escaped-path>/<uuid>.jsonl
// + ~/.workbuddy/sessions/*.json 心跳文件（实时活跃信号）
const path = require('path');
const os = require('os');
const fs = require('fs');
const { collectFiles, readAll, tailRead } = require('../watcher');

const ID = 'workbuddy';
const ROOT = path.join(os.homedir(), '.workbuddy', 'projects');
const HEARTBEAT_DIR = path.join(os.homedir(), '.workbuddy', 'sessions');

function isSessionFile(p) { return p.endsWith('.jsonl'); }
function isHeartbeat(p) { return p.endsWith('.json') && !p.includes('settings') && !p.includes('sessions.json'); }

function extractText(content) {
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

function parseLines(lines) {
  const out = [];
  for (const line of lines) {
    try {
      if (line.type === 'ai-title' && line.sessionId) {
        out.push({
          agent: ID, sourceId: `title:${line.sessionId}`,
          sessionId: line.sessionId, ts: Number(line.timestamp) || 0,
          role: 'system', kind: 'title', text: '', title: String(line.aiTitle || '').trim(),
          project: line.cwd || '',
        });
        continue;
      }
      if (line.type !== 'message' || !line.sessionId) continue;
      const text = extractText(line.content);
      if (!text) continue;
      out.push({
        agent: ID,
        sourceId: line.id || (line.sessionId + ':' + line.timestamp + ':' + Math.random()),
        sessionId: line.sessionId,
        ts: Number(line.timestamp) || Date.now(),
        role: line.role === 'user' ? 'user' : 'assistant',
        kind: 'message',
        text,
        project: line.cwd || '',
      });
    } catch { /* skip */ }
  }
  return out;
}

// 心跳扫描：读取 ~/.workbuddy/sessions/*.json，报告每个活动会话
function scanHeartbeats(store) {
  const out = [];
  if (!fs.existsSync(HEARTBEAT_DIR)) return out;
  let entries;
  try { entries = fs.readdirSync(HEARTBEAT_DIR); } catch { return out; }
  const now = Date.now();
  for (const name of entries) {
    const p = path.join(HEARTBEAT_DIR, name);
    if (!name.endsWith('.json')) continue;
    try {
      const d = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (!d.sessionId) continue;
      const hb = Number(d.lastHeartbeat) || 0;
      // 心跳在 5 分钟内视为活跃
      const active = now - hb < 5 * 60 * 1000;
      const info = {
        agent: ID,
        sessionId: d.sessionId,
        project: d.cwd || '',
        title: '',
        lastActivity: hb || now,
        active,
      };
      out.push(info);
      if (active) {
        // 用当前扫描时间更新活跃状态（而非心跳文件里的旧时间戳），
        // 避免文件写入延迟导致 lastActivity 停在 3 分钟窗口边缘反复过期 → 状态闪烁
        store.touchActive(`${ID}:${d.sessionId}`, { agent: ID, project: d.cwd || '' }, now);
        // 确保会话存在（无消息也可见）
        store.ingest({
          agent: ID, sourceId: `hb:${d.sessionId}`, sessionId: d.sessionId,
          ts: hb, role: 'system', kind: 'heartbeat', text: '',
          project: d.cwd || '',
        });
      }
    } catch { /* skip */ }
  }
  return out;
}

function fileToSessionId(file) { return path.basename(file).replace(/\.jsonl$/, ''); }

module.exports = {
  ID, ROOT, isSessionFile, parseLines, scanHeartbeats, fileToSessionId,
  scanAll(store) {
    const files = collectFiles(ROOT, isSessionFile);
    let count = 0;
    for (const f of files) {
      const key = `offset:${ID}:${f}`;
      const offset = Number(store.stmts.getMeta.get(key)?.v || 0);
      const { lines, newOffset } = readAll(f, offset);
      if (lines.length) {
        for (const m of parseLines(lines)) { store.ingest(m); count++; }
      }
      store.stmts.setMeta.run(key, String(newOffset));
    }
    scanHeartbeats(store);
    return count;
  },
  poll(store, changedPaths) {
    let count = 0;
    for (const f of changedPaths) {
      if (isSessionFile(f)) {
        const key = `offset:${ID}:${f}`;
        const offset = Number(store.stmts.getMeta.get(key)?.v || 0);
        const { lines, newOffset } = tailRead(f, offset);
      if (lines.length) {
        const msgs = parseLines(lines);
        for (const m of msgs) { store.ingest(m); count++; }
        // 活跃信号用当前时间：文件在写 = agent 在运行，避免消息间隔超过窗口导致状态闪烁
        if (msgs.length) {
          const last = msgs[msgs.length - 1];
          store.touchActive(`${ID}:${last.sessionId}`, { agent: ID, project: last.project }, Date.now());
        }
      }
        store.stmts.setMeta.run(key, String(newOffset));
      } else if (f.startsWith(HEARTBEAT_DIR) && f.endsWith('.json')) {
        scanHeartbeats(store);
      }
    }
    return count;
  },
};
