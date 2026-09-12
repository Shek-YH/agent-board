'use strict';
// 文件监听与增量读取工具（零依赖，Node 内置 fs）
const fs = require('node:fs');
const path = require('node:path');

// 递归收集目录下所有匹配文件
/** @param {string} root @param {(filePath: string) => boolean} filter @param {number} maxDepth */
function collectFiles(root, filter = () => true, maxDepth = 6) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    /** @type {import('node:fs').Dirent[]} */
    let entries = [];
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

function readRangeSync(filePath, position, length) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    let bytesRead = 0;
    while (bytesRead < length) {
      const read = fs.readSync(fd, buffer, bytesRead, length - bytesRead, position + bytesRead);
      if (!read) break;
      bytesRead += read;
    }
    return bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
  } finally {
    fs.closeSync(fd);
  }
}

async function readRangeAsync(filePath, position, length) {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    let bytesRead = 0;
    while (bytesRead < length) {
      const result = await handle.read(buffer, bytesRead, length - bytesRead, position + bytesRead);
      if (!result.bytesRead) break;
      bytesRead += result.bytesRead;
    }
    return bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function parseCompleteLines(buffer, lastNewline) {
  const lines = [];
  for (const raw of buffer.subarray(0, lastNewline).toString('utf8').split('\n')) {
    const ln = raw.trim();
    if (!ln) continue;
    try { lines.push(JSON.parse(ln)); } catch { /* 跳过坏行 */ }
  }
  return lines;
}

// 从 offset 读取文件新增字节，逐行 JSON.parse；返回 { lines, newOffset }。
// 只申请 maxBytes 大小的 Buffer，offset 和 newOffset 均按原始字节计算。
function tailRead(filePath, offset, maxBytes = 8 * 1024 * 1024) {
  let st;
  try { st = fs.statSync(filePath); } catch { return { lines: [], newOffset: offset }; }
  if (st.size <= offset) return { lines: [], newOffset: offset };
  const start = Math.max(0, Number(offset) || 0);
  const length = Math.min(Math.max(0, Number(maxBytes) || 0), st.size - start);
  if (!length) return { lines: [], newOffset: offset };
  const buffer = readRangeSync(filePath, start, length);
  // 按原始字节定位换行，避免 UTF-8 重编码改变 offset。
  const nl = buffer.lastIndexOf(0x0a);
  if (nl === -1) return { lines: [], newOffset: offset };
  return { lines: parseCompleteLines(buffer, nl), newOffset: start + nl + 1 };
}

// 异步版：使用受控 range read，避免为了增量读取将整个文件载入内存。
async function tailReadAsync(filePath, offset, maxBytes = 8 * 1024 * 1024) {
  let st;
  try { st = await fs.promises.stat(filePath); } catch { return { lines: [], newOffset: offset }; }
  if (st.size <= offset) return { lines: [], newOffset: offset };
  const start = Math.max(0, Number(offset) || 0);
  const length = Math.min(Math.max(0, Number(maxBytes) || 0), st.size - start);
  if (!length) return { lines: [], newOffset: offset };
  const buffer = await readRangeAsync(filePath, start, length);
  const nl = buffer.lastIndexOf(0x0a);
  if (nl === -1) return { lines: [], newOffset: offset };
  return { lines: parseCompleteLines(buffer, nl), newOffset: start + nl + 1 };
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

// 异步版 readAll：所有 fs 操作都不阻塞 event loop
async function readAllAsync(filePath, offset, maxBytes = 8 * 1024 * 1024) {
  const allLines = [];
  let cur = Number(offset) || 0;
  const maxIter = 64;
  for (let i = 0; i < maxIter; i++) {
    const { lines, newOffset } = await tailReadAsync(filePath, cur, maxBytes);
    if (lines.length) allLines.push(...lines);
    if (newOffset <= cur) break;
    cur = newOffset;
    let st;
    try { st = await fs.promises.stat(filePath); } catch { break; }
    if (cur >= st.size) break;
  }
  return { lines: allLines, newOffset: cur };
}

// 读取文件末尾 maxBytes 的完整行（用于大文件只取最近消息）
function tailRecent(filePath, maxBytes = 512 * 1024) {
  let st;
  try { st = fs.statSync(filePath); } catch { return { lines: [] }; }
  const readLen = Math.min(st.size, maxBytes);
  if (!readLen) return { lines: [], offset: st.size };
  const buffer = readRangeSync(filePath, st.size - readLen, readLen);
  const firstNl = buffer.indexOf(0x0a);
  if (firstNl === -1) return { lines: [], offset: st.size };
  const lines = [];
  for (const raw of buffer.subarray(firstNl + 1).toString('utf8').split('\n')) {
    const ln = raw.trim();
    if (!ln) continue;
    try { lines.push(JSON.parse(ln)); } catch { /* skip */ }
  }
  return { lines, offset: st.size };
}

module.exports = {
  collectFiles, snapshotTree, diffSnapshots, shouldResetOffset, fileSignature,
  watchTree, tailRead, tailReadAsync, readAll, readAllAsync, tailRecent, fileMtime, fileSize,
};
