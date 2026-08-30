'use strict';
// idle-check.js — Codex 会话「1 分钟停顿检测」：文件停止写入 > 60s 且最后一条真实消息是 assistant
// → 等价于执行 signal-done.js（写入 doneSignalAt，进程检查/心跳都碰不到，只有晚于信号时刻的新消息可解锁）。
// 为什么不用 hook：Codex Windows 桌面 hooks 框架有 bug（hooks.json command spawn 失败 exit 1；
// inline config.toml 直接白屏），AGENTS.md 指令 codex 也不执行。这是唯一可靠路径。
const fs = require('fs');
const path = require('path');
const { collectFiles } = require('./watcher');
const { SOURCE_PATHS } = require('./source-paths');

const ID = 'codex';
const ROOT = SOURCE_PATHS.codex;

const CODEX_IDLE_MS = 60 * 1000;   // 文件静止超过 60s → 视为会话结束（用户要求 1 分钟）
const CODEX_FRESH_MS = 30 * 1000;  // 30s 内有写入 → agent 正在跑
const CODEX_DEBOUNCE_MS = 20 * 1000; // 1 次 20s 定时器周期命中即判（60s 静止本身足够长，无需双重防抖）

// 每 ref 首次「疑似结束」时间（内存态）
const idleSince = new Map();

function isSessionFile(p) { return p.endsWith('.jsonl') && path.basename(p).startsWith('rollout-'); }
function fileToSessionId(p) { return path.basename(p).replace(/\.jsonl$/, '').replace(/^rollout-/, ''); }

// codex 末行「可能是完成态」判定：
// 工具执行中的行（function_call / function_call_output）不算完成；其余（response_item / event_msg / summary 等）可判。
function lastLineLooksDone(f) {
  let fd = null;
  try {
    fd = fs.openSync(f, 'r');
    const size = fs.fstatSync(fd).size;
    if (size <= 0) return true;
    const buf = Buffer.alloc(Math.min(size, 64 * 1024));
    fs.readSync(fd, buf, 0, buf.length, Math.max(0, size - buf.length));
    const text = buf.toString('utf8');
    const tail = text.endsWith('\n') ? text.slice(0, -1) : text;
    const idx = tail.lastIndexOf('\n');
    const lastLine = (idx >= 0 ? tail.slice(idx + 1) : tail).trim();
    if (!lastLine) return true;
    const o = JSON.parse(lastLine);
    // response_item 的工具类 payload → 正在执行工具，不算完成
    if (o && o.payload && (o.payload.type === 'function_call' || o.payload.type === 'function_call_output')) return false;
    return true;
  } catch { return true; }
  finally { if (fd) { try { fs.closeSync(fd); } catch { /* ignore */ } } }
}

// server.js 每 20s 调用：Codex 会话停顿检测 → 提前结束「进行中」（约 1 分钟）
function checkCodexIdle(store) {
  if (!fs.existsSync(ROOT)) return;
  const now = Date.now();
  let files;
  try { files = collectFiles(ROOT, isSessionFile); } catch { return; }
  for (const f of files) {
    let st;
    try { st = fs.statSync(f); } catch { continue; }
    const ref = `${ID}:${fileToSessionId(f)}`;
    const idle = now - st.mtimeMs;
    const lastRole = store.getLastRole(ref);
    if (!lastRole) { idleSince.delete(ref); continue; } // 尚未 ingest 任何消息的会话不判

    if (idle < CODEX_FRESH_MS) {
      // 正在写 = 在跑（若之前误判完成，ingest 会按 ts 比较自动解锁 doneSignalAt）
      idleSince.delete(ref);
    } else if (idle > CODEX_IDLE_MS && lastRole === 'assistant') {
      if (!lastLineLooksDone(f)) { idleSince.delete(ref); continue; }
      const first = idleSince.get(ref) || now;
      idleSince.set(ref, first);
      if (now - first >= CODEX_DEBOUNCE_MS) {
        // 等价于执行 signal-done.js --agent codex（doneSignalAt 独立标记，进程检查不碰）
        store.setDoneSignal(ref, now);
      }
    } else {
      idleSince.delete(ref); // 30~60s 中间地带：可能是思考间隙，重置
    }
  }
}

module.exports = { checkCodexIdle, lastLineLooksDone };
