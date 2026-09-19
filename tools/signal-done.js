'use strict';
// signal-done.js — AI agent 完成信号脚本（供 Claude Code / Codex 的 Stop hook 与全局约束文件指令调用）
// 作用：agent 完成本轮最后输出时，静默通知 Agent Board 看板（127.0.0.1:4876）把当前会话立即
// 标记为「已完成」（不再等 10 分钟消息窗口）。
//
// 用法：
//   node signal-done.js --agent claude                       # 由 hook 调用：自动从 stdin JSON 读取 session_id / transcript_path
//   node signal-done.js --agent codex --session X          # 指令式调用：显式指定会话 id（不传则由看板解析最近活跃会话）
//   node signal-done.js --agent codex --delay 10000         # 发信号前 sleep 10 秒（让所有 reply 内容先落盘，避免被后续消息解锁；hook 不可用时的 fallback）
//   node signal-done.js --agent workbuddy                    # 仅看板兜底解析
//
// 设计原则：绝对静默——任何失败都不报错、不输出到 stdout（Stop hook 输出会被 agent 解析，必须保持干净）。
// 调试：所有阶段都写详细日志到 %TEMP%\codex-signal-done.log（Codex 启动时静默失败也能查）。
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { getDataDir } = require('../lib/runtime-paths');

const DEFAULT_BOARD = { host: '127.0.0.1', port: 4876, path: '/api/complete', token: '' };
const COMPLETE_HOOK_CONFIG_PATH = path.join(getDataDir(), 'hooks', 'complete-hook.json');
const DEBUG_LOG = path.join(os.tmpdir(), 'codex-signal-done.log');

function dlog(msg) {
  try { fs.appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${msg}\n`); } catch { /* ignore */ }
}
dlog(`--- 启动 argv=${JSON.stringify(process.argv.slice(2))}`);

function loadBoardConfig(filePath = COMPLETE_HOOK_CONFIG_PATH) {
  try {
    const config = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const url = new URL(String(config?.url || ''));
    if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname) || url.pathname !== '/api/complete' || typeof config.token !== 'string' || !config.token.trim()) return DEFAULT_BOARD;
    return { host: url.hostname, port: Number(url.port) || 80, path: url.pathname, token: config.token.trim() };
  } catch {
    return DEFAULT_BOARD;
  }
}

const BOARD = loadBoardConfig();

function parseArgs(argv) {
  const out = { agent: '', session: '', delay: 0 };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--agent') out.agent = String(argv[++i] || '');
    else if (argv[i] === '--session') out.session = String(argv[++i] || '');
    else if (argv[i] === '--delay') out.delay = Math.max(0, Number(argv[++i] || 0));
  }
  return out;
}

// 从 hook 的 stdin JSON 提取会话信息
function readHookStdin() {
  try {
    if (!process.stdin.isTTY) {
      const raw = fs.readFileSync(0, 'utf8').trim();
      if (raw) {
        const o = JSON.parse(raw);
        return {
          sessionId: String(o.session_id || o.sessionId || ''),
          transcriptPath: String(o.transcript_path || o.transcriptPath || ''),
        };
      }
    }
  } catch (e) { dlog('stdin parse error: ' + e.message); }
  return { sessionId: '', transcriptPath: '' };
}

// 从 transcript_path 推导与看板一致的 sessionId：
//   claude:  ~/.claude/projects/<escaped>/<uuid>.jsonl          -> basename 去 .jsonl = uuid
//   codex:   ~/.codex/sessions/YYYY/MM/DD/rollout-<name>.jsonl  -> basename 去 .jsonl 再去 rollout- 前缀
function deriveFromTranscript(p) {
  if (!p) return '';
  let name = p.split(/[\\/]/).pop() || '';
  if (name.endsWith('.jsonl')) name = name.slice(0, -6);
  if (name.startsWith('rollout-')) name = name.slice(8);
  return name;
}

function post(agent, sessionId) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ agent, sessionId });
    const req = http.request({
      host: BOARD.host, port: BOARD.port, path: BOARD.path,
      method: 'POST', timeout: 3000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...(BOARD.token ? { Authorization: `Bearer ${BOARD.token}` } : {}) },
    }, (res) => {
      dlog(`POST ${res.statusCode}`);
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('timeout', () => { dlog('POST timeout'); req.destroy(); resolve(0); });
    req.on('error', (e) => { dlog('POST error: ' + e.message); resolve(0); });
    req.end(body);
  });
}

(async () => {
  const args = parseArgs(process.argv);
  if (!args.agent) { dlog('no --agent, exit'); return process.exit(0); }
  const hook = readHookStdin();
  const sessionId = args.session || hook.sessionId || deriveFromTranscript(hook.transcriptPath);
  dlog(`resolved=${sessionId || '(empty)'}`);
  if (args.delay > 0) {
    const t = Date.now();
    while (Date.now() - t < args.delay) { /* spin */ }
  }
  try {
    const code = await post(args.agent, sessionId);
    dlog(`done code=${code}`);
    // 输出最小合法 JSON 到 stdout（Codex Stop hook 要求 JSON stdout，纯文本被忽略；
    // 输出 {} 是最稳的 noop），然后显式 exit 0
    try { process.stdout.write('{}\n'); } catch { /* ignore */ }
  } catch (e) {
    dlog('exception: ' + (e && e.stack || e));
  }
  process.exit(0);
})();
