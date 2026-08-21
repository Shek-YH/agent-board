'use strict';
// DeepSeek Harness 适配器：解析 ~/.dsh/sessions/<workspace>/session-<uuid>/session.jsonl.zstd
// DeepSeek Harness 把每次会话存为 zstd 压缩的 JSONL，通过 Python zstandard 解压后读取。
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { collectFiles } = require('../watcher');

const ID = 'deepseek';
const ROOT = path.join(os.homedir(), '.dsh', 'sessions');

// 优先使用管理好的 Python venv（已安装 zstandard），可通过环境变量覆盖
const PYTHON = process.env.AGENTBOARD_PYTHON ||
  path.join(os.homedir(), '.workbuddy', 'binaries', 'python', 'envs', 'default', 'Scripts', 'python.exe');
const DECOMPRESSOR = path.join(__dirname, '..', 'decompress-zstd.py');

function isSessionFile(p) { return p.endsWith('.jsonl.zstd'); }

function fileToSessionId(file) {
  // 文件目录：.../session-<uuid>/session.jsonl.zstd
  return path.basename(path.dirname(file));
}

function extractText(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const c of content) {
    if (!c || typeof c !== 'object') continue;
    // 只取纯文本结果；reasoning / tool-call 属于中间过程，不展示
    if (c.type === 'text' && c.text) parts.push(c.text);
  }
  return parts.join('\n').trim();
}

function decompress(file) {
  try {
    const r = spawnSync(PYTHON, [DECOMPRESSOR, file], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 30000,
      windowsHide: true,
    });
    if (r.error || r.status !== 0) {
      console.error(`[${ID}] decompress failed for ${file}:`, r.stderr || r.error?.message || 'unknown');
      return '';
    }
    return r.stdout || '';
  } catch (e) {
    console.error(`[${ID}] decompress exception for ${file}:`, e.message);
    return '';
  }
}

function tailRead(file, offset) {
  const text = decompress(file);
  if (!text) return { lines: [], newOffset: offset };
  const allRaw = text.split('\n');
  const lines = [];
  for (let i = offset; i < allRaw.length; i++) {
    const ln = allRaw[i].trim();
    if (!ln) continue;
    try { lines.push(JSON.parse(ln)); } catch { /* 跳过坏行 */ }
  }
  return { lines, newOffset: allRaw.length };
}

function parseLines(lines) {
  const out = [];
  let project = '';
  let sessionId = '';
  let title = '';
  let titleSource = '';

  for (const line of lines) {
    if (!line || typeof line !== 'object') continue;
    try {
      const type = line.type;

      if (type === 'session') {
        project = line.cwd || '';
        sessionId = line.id || '';
        continue;
      }

      if (type === 'session/title' && line.data && line.data.title) {
        const src = (line.data.source && line.data.source.kind) || 'fallback';
        // provider 生成的标题优先于 fallback；同来源取后出现的
        if (src === 'provider' || titleSource !== 'provider') {
          title = String(line.data.title).trim();
          titleSource = src;
        }
        continue;
      }

      if (type === 'user/message' && line.data) {
        // 过滤系统提示 / plugin 注入的 user 消息，只保留真实用户输入
        const sourceKind = line.data.source && line.data.source.kind;
        if (sourceKind !== 'user') continue;
        const text = extractText(line.data.content);
        if (!text) continue;
        out.push({
          agent: ID,
          sourceId: line.seq != null ? `u:${line.seq}` : `u:${Math.random()}`,
          sessionId,
          ts: Number(line.time) || 0,
          role: 'user',
          kind: 'message',
          text,
          project,
        });
        continue;
      }

      if (type === 'assistant/message' && line.data && line.data.message) {
        const msg = line.data.message;
        const text = extractText(msg.content);
        if (!text) continue;
        out.push({
          agent: ID,
          sourceId: line.seq != null ? `a:${line.seq}` : `a:${Math.random()}`,
          sessionId,
          ts: Number(line.time) || 0,
          role: 'assistant',
          kind: 'message',
          text,
          project,
        });
        continue;
      }
    } catch { /* 跳过异常行 */ }
  }

  if (title && sessionId) {
    out.unshift({
      agent: ID,
      sourceId: `title:${sessionId}`,
      sessionId,
      ts: 0, // 标题不推高 last_seen
      role: 'system',
      kind: 'title',
      text: '',
      title,
      project,
    });
  }

  return out;
}

module.exports = {
  ID, ROOT, isSessionFile, fileToSessionId, parseLines, tailRead,
  readFile: tailRead,
  scanAll(store) {
    const files = collectFiles(ROOT, isSessionFile, 6);
    let count = 0;
    for (const f of files) {
      const key = `offset:${ID}:${f}`;
      const offset = Number(store.stmts.getMeta.get(key)?.v || 0);
      const { lines, newOffset } = tailRead(f, offset);
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
