'use strict';
// 文件监听与增量读取工具（零依赖，Node 内置 fs）
const fs = require('fs');
const path = require('path');

// 递归收集目录下所有匹配文件
function collectFiles(root, filter = () => true, maxDepth = 6) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      try {
        if (e.isDirectory()) walk(p, depth + 1);
        else if (filter(p)) out.push(p);
      } catch { /* ignore */ }
    }
  };
  if (fs.existsSync(root)) walk(root, 0);
  return out;
}

function fileSignature(filePath) {
  try {
    const st = fs.statSync(filePath);
    return {
      size: st.size,
      mtimeMs: st.mtimeMs,
      ctimeMs: st.ctimeMs,
      identity: [st.dev, st.ino, st.birthtimeMs].map((value) => Number.isFinite(value) ? value : '').join(':'),
    };
  } catch {
    return null;
  }
}

function snapshotTree(root, filter = () => true, maxDepth = 6) {
  const snapshot = {};
  for (const filePath of collectFiles(root, filter, maxDepth)) {
    const signature = fileSignature(filePath);
    if (signature) snapshot[filePath] = signature;
  }
  return snapshot;
}

function sameSignature(left, right) {
  return Boolean(left && right)
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
    && left.identity === right.identity;
}

function diffSnapshots(previous = {}, current = {}) {
  const changed = [];
  const deleted = [];
  for (const filePath of Object.keys(current)) {
    if (!sameSignature(previous[filePath], current[filePath])) changed.push(filePath);
  }
  for (const filePath of Object.keys(previous)) {
    if (!current[filePath]) deleted.push(filePath);
  }
  return { changed, deleted };
}

function shouldResetOffset(previous, current) {
  if (!previous || !current) return false;
  return previous.identity !== current.identity || current.size < previous.size;
}

// 递归监听一个根目录（Node 22 Windows 支持 recursive）
// onEvent: (filePath) => void；返回 stop()
function watchTree(root, onEvent, debounceMs = 800) {
  let timer = null;
  let pending = new Set();
  const fire = () => {
    const paths = [...pending];
    pending = new Set();
    for (const p of paths) onEvent(p);
  };
  let watcher;
  try {
    if (!fs.existsSync(root)) throw new Error('watch root is not available');
    watcher = fs.watch(root, { recursive: true }, (evt, name) => {
      if (!name) return;
      const full = path.join(root, name.toString());
      pending.add(full);
      if (timer) clearTimeout(timer);
      timer = setTimeout(fire, debounceMs);
    });
  } catch {
    // recursive 失败时退化为轮询
    let snapshot = snapshotTree(root, () => true);
    watcher = setInterval(() => {
      const current = snapshotTree(root, () => true);
      const diff = diffSnapshots(snapshot, current);
      for (const filePath of [...diff.changed, ...diff.deleted]) pending.add(filePath);
      snapshot = current;
      if (pending.size) fire();
    }, 2000);
    return () => clearInterval(watcher);
  }
  return () => {
    if (timer) clearTimeout(timer);
    try { watcher.close(); } catch { /* ignore */ }
  };
}

// 从 offset 读取文件新增字节，逐行 JSON.parse；返回 { lines, newOffset }
function tailRead(filePath, offset, maxBytes = 8 * 1024 * 1024) {
  let st;
  try { st = fs.statSync(filePath); } catch { return { lines: [], newOffset: offset }; }
  if (st.size <= offset) return { lines: [], newOffset: offset };
  const start = Math.max(0, offset);
  const buf = fs.readFileSync(filePath);
  const chunk = buf.subarray(start, Math.min(start + maxBytes, buf.length)).toString('utf8');
  // 只在有完整换行时才解析，最后不完整的行留到下次
  const nl = chunk.lastIndexOf('\n');
  if (nl === -1) return { lines: [], newOffset: offset };
  const complete = chunk.slice(0, nl);
  const newOffset = start + Buffer.byteLength(complete, 'utf8') + 1;
  const lines = [];
  for (const raw of complete.split('\n')) {
    const ln = raw.trim();
    if (!ln) continue;
    try { lines.push(JSON.parse(ln)); } catch { /* 跳过坏行 */ }
  }
  return { lines, newOffset };
}

function fileMtime(p) {
  try { return fs.statSync(p).mtimeMs; } catch { return 0; }
}

function fileSize(p) {
  try { return fs.statSync(p).size; } catch { return 0; }
}

// 全量读取：循环 tailRead 直到读完整个文件（大文件 >maxBytes 时首轮只读前 maxBytes，
// 必须继续循环，否则 scanAll 首轮后剩余消息永久丢失）
function readAll(filePath, offset, maxBytes = 8 * 1024 * 1024) {
  const allLines = [];
  let cur = Number(offset) || 0;
  const maxIter = 64;
  for (let i = 0; i < maxIter; i++) {
    const { lines, newOffset } = tailRead(filePath, cur, maxBytes);
    if (lines.length) allLines.push(...lines);
    if (newOffset <= cur) break; // 无进展（文件未变/已读完）
    cur = newOffset;
    // 文件已读完的判断：cur >= size 或本次未达到 maxBytes 上限
    let st;
    try { st = require('fs').statSync(filePath); } catch { break; }
    if (cur >= st.size) break;
  }
  return { lines: allLines, newOffset: cur };
}

// 读取文件末尾 maxBytes 的完整行（用于大文件只取最近消息）
function tailRecent(filePath, maxBytes = 512 * 1024) {
  let st;
  try { st = fs.statSync(filePath); } catch { return { lines: [] }; }
  const readLen = Math.min(st.size, maxBytes);
  const buf = fs.readFileSync(filePath);
  const chunk = buf.subarray(buf.length - readLen).toString('utf8');
  const firstNl = chunk.indexOf('\n');
  const lines = [];
  const from = firstNl === -1 ? 0 : firstNl + 1;
  for (const raw of chunk.slice(from).split('\n')) {
    const ln = raw.trim();
    if (!ln) continue;
    try { lines.push(JSON.parse(ln)); } catch { /* skip */ }
  }
  return { lines, offset: st.size };
}

module.exports = {
  collectFiles, snapshotTree, diffSnapshots, shouldResetOffset, fileSignature,
  watchTree, tailRead, readAll, tailRecent, fileMtime, fileSize,
};
