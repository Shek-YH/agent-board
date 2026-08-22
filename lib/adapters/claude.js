'use strict';
// Claude Code 适配器：解析 ~/.claude/projects/<escaped-path>/<uuid>.jsonl
const path = require('path');
const os = require('os');
const { collectFiles, readAll, tailRead } = require('../watcher');

const ID = 'claude';
const ROOT = path.join(os.homedir(), '.claude', 'projects');

function isSessionFile(p) { return p.endsWith('.jsonl'); }

function extractText(content) {
  // Claude Code 的 content 可能是数组 [{type:'text',text}] 也可能是纯字符串（新版本）
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const c of content) {
    if (!c || typeof c !== 'object') continue;
    if (c.type === 'text' && c.text) parts.push(c.text);
    else if (c.type === 'input_text' && c.text) parts.push(c.text); // 兼容新格式
  }
  return parts.join('\n').trim();
}

function parseLines(lines) {
  const out = [];
  for (const line of lines) {
    try {
      // 官方会话标题行（Claude Code custom-title）；该行无 timestamp，缺失时用 0 不推高 last_seen
      if (line.type === 'custom-title' && line.sessionId && line.customTitle) {
        out.push({
          agent: ID, sourceId: `title:${line.sessionId}`,
          sessionId: line.sessionId, ts: 0,
          role: 'system', kind: 'title', text: '', title: String(line.customTitle).trim(),
          project: line.cwd || '',
        });
        continue;
      }
      if (line.type !== 'user' && line.type !== 'assistant' && line.type !== 'summary') continue;
      if (!line.message || !line.sessionId) continue;
      const text = extractText(line.message.content);
      // timestamp 缺失/非法时跳过该行（绝不用 Date.now() 兜底，否则会把老会话顶到今天）
      const ts = Date.parse(line.timestamp);
      if (!ts) continue;
      const role = line.type === 'summary' ? 'assistant' : line.type;
      const sourceId = line.uuid || (line.sessionId + ':' + line.timestamp + ':' + Math.random());
      out.push({
        agent: ID,
        sourceId,
        sessionId: line.sessionId,
        ts,
        role,
        kind: line.type === 'summary' ? 'summary' : 'message',
        text,
        project: line.cwd || '',
      });
      // 回合结束显式信号：assistant 消息 stop_reason !== 'tool_use' = 本轮未再调用工具、
      // 交还控制权给用户（真正回合结束）；isSidechain（Task 子代理）排除，否则子代理收尾
      // 会把主会话误判成已完成。
      if (role === 'assistant' && !line.isSidechain) {
        const stopReason = line.message.stop_reason;
        if (stopReason && stopReason !== 'tool_use') {
          out.push({ agent: ID, sourceId: `${sourceId}:turnend`, sessionId: line.sessionId, ts, kind: 'turn_end' });
        }
      }
    } catch { /* skip */ }
  }
  return out;
}

// 返回 sessionId -> project 映射（用文件所在目录推断 cwd，作为兜底）
function sessionProjectMap() {
  const map = {};
  for (const f of collectFiles(ROOT, isSessionFile)) {
    const dir = path.basename(path.dirname(f));
    map[dir] = dir;
  }
  return map;
}

function fileToSessionId(file) { return path.basename(file).replace(/\.jsonl$/, ''); }

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
        for (const m of parseLines(lines)) { store.ingest(m); count++; }
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
        const msgs = parseLines(lines);
        for (const m of msgs) { store.ingest(m); count++; }
        // 活跃信号：watch 触发 = 文件确实在写入 = Claude 正在运行。
        // 用当前时间而非消息时间戳——消息写入间隔（思考/工具执行/等响应）可能超过活跃窗口，
        // 若用旧消息时间戳会导致 lastActivity 掉出窗口 → 状态反复闪烁。
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
