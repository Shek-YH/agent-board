'use strict';
// Agent Board 服务器：HTTP 静态 + REST + SSE 实时推送
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { exec, spawn, spawnSync } = require('child_process');
const store = require('./lib/store');
const detect = require('./lib/detect');
const watcher = require('./lib/watcher');
const claude = require('./lib/adapters/claude');
const codex = require('./lib/adapters/codex');
const workbuddy = require('./lib/adapters/workbuddy');
const idleCheck = require('./lib/idle-check');
const deepseek = require('./lib/adapters/deepseek');
const marvis = require('./lib/adapters/marvis');
const doubao = require('./lib/adapters/doubao');
const zcode = require('./lib/adapters/zcode');
const pi = require('./lib/adapters/pi');

const PORT = Number(process.env.AB_PORT || 4876);
const PUBLIC = path.join(__dirname, 'public');

// ---------- Agent 可扩展配置表 ----------
// 新增 agent：加一条定义即可（proc=进程名用于激活；scheme=URL协议用于冷启动拉起；launch=备选启动命令；icon=public/icons 下的图标文件）
const AGENT_DEFS = {
  claude:    { name: 'Claude Code',      color: '#D97757', icon: 'claude.png',    proc: 'claude',    scheme: 'claude://',     launch: null },
  codex:     { name: 'Codex',            color: '#10A37F', icon: 'codex.png',     proc: 'Codex',     scheme: 'codex://',      launch: null },
  workbuddy: { name: 'WorkBuddy',        color: '#3B82F6', icon: 'workbuddy.png', proc: 'WorkBuddy', scheme: 'workbuddy://',  launch: null },
  deepseek:  { name: 'DeepSeek Harness', color: '#4D6BFE', icon: 'deepseek.png',  proc: 'deepseek-harness', scheme: null,   launch: null,
    launchCmd: '"C:\\Users\\Administrator\\Desktop\\DeepSeek Harness.bat"' },
  marvis:    { name: 'Marvis',           color: '#7C3AED', icon: 'marvis.png',    proc: 'Marvis',    scheme: null,            launch: null,
    launch: '"C:\\Users\\Administrator\\WorkBuddy\\2026-08-20-03-52-10\\agent-board\\marvis-launch.bat"' },
  doubao:    { name: '豆包',              color: '#00A6F0', icon: 'doubao.jpg',    proc: 'Doubao',    scheme: 'doubao://',     launch: null },
  zcode:     { name: 'ZCode',            color: '#1772F0', icon: 'zcode.png',     proc: 'ZCode',     scheme: null,            launch: null,
    launch: '"C:\\Users\\Administrator\\WorkBuddy\\2026-08-20-03-52-10\\agent-board\\zcode-launch.bat"' },
  pi:        { name: 'Pi Agent',         color: '#01BEBF', icon: 'pi.png',        proc: 'pi',        scheme: null,            launch: null,
    launchCmd: '"C:\\Users\\Administrator\\WorkBuddy\\2026-08-20-03-52-10\\agent-board\\pi-launch.bat"' },
};

// 去掉配置值两端可能存在的引号（兼容旧配置写法）
function stripQuotes(s) {
  if (typeof s !== 'string') return s;
  const m = s.match(/^"(.+)"$/);
  return m ? m[1] : s;
}

// 窗口激活：未运行 -> 按 scheme/launch 启动；运行中 -> 激活到前台
function launchOrFocus(agent, cb) {
  const def = AGENT_DEFS[agent];
  if (!def) { cb({ ok: false, error: '未知 agent' }); return; }
  // launchCmd 用于浏览器/Web 类应用：直接调用外部启动脚本（含自启动+开浏览器逻辑），不再走窗口句柄激活
  if (def.launchCmd) {
    const p = stripQuotes(def.launchCmd);
    spawn('cmd.exe', ['/c', p], { windowsHide: true, detached: true }).unref();
    cb({ ok: true, action: 'launch', agent });
    return;
  }
  focusAppCall(def.proc, (result) => {
    if (result.startsWith('OK')) {
      cb({ ok: true, action: 'focus', pid: result.split(':')[1] || '' });
    } else if (result === 'NOT_RUNNING') {
      if (def.scheme) {
        spawn('cmd.exe', ['/c', 'start', '', def.scheme], { windowsHide: true, detached: true }).unref();
      } else if (def.launch) {
        const p = stripQuotes(def.launch);
        spawn('cmd.exe', ['/c', p], { windowsHide: true, detached: true }).unref();
      } else {
        cb({ ok: false, error: '未配置启动方式，请打开应用后重试' });
        return;
      }
      // 等应用起来后再次激活窗口
      setTimeout(() => {
        focusAppCall(def.proc, (r2) => cb({ ok: true, action: 'launched', pid: r2.startsWith('OK:') ? r2.split(':')[1] : '' }));
      }, 3000);
    } else {
      cb({ ok: false, error: result });
    }
  });
}

// ---------- 窗口激活：预编译 Win32 DLL（避免每次点跳转都重新编译 C#） ----------
const FOCUS_DLL = path.join(require('os').homedir(), '.agent-board', 'wf.dll');
const FOCUS_CS = `
using System;
using System.Runtime.InteropServices;
public class WF {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte s, uint f, UIntPtr e);
}
`;
function ensureFocusDll() {
  if (fs.existsSync(FOCUS_DLL)) return Promise.resolve();
  const ps = `$dir = "$env:USERPROFILE\\.agent-board"; if (-not (Test-Path $dir)) { New-Item -ItemType Directory $dir | Out-Null }; Add-Type -TypeDefinition @"
${FOCUS_CS}
"@ -OutputAssembly "$dir\\wf.dll"`;
  return new Promise((resolve) => {
    const enc = Buffer.from(ps, 'utf16le').toString('base64');
    exec(`powershell -NoProfile -NonInteractive -EncodedCommand ${enc}`, { windowsHide: true }, () => resolve());
  });
}

// 常驻 PowerShell 交互进程：DLL 只加载一次，之后毫秒级执行激活
let focusPs = null, focusReady = false, focusBuf = '', focusQueue = [];
function initFocusPs() {
  if (focusPs) return;
  focusPs = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', '-'], { windowsHide: true });
  focusPs.stderr.on('data', () => {});
  focusPs.stdout.on('data', (d) => {
    focusBuf += d.toString();
    let idx;
    while ((idx = focusBuf.indexOf('\n')) >= 0) {
      const line = focusBuf.slice(0, idx).trim();
      focusBuf = focusBuf.slice(idx + 1);
      if (line === 'READY') {
        focusReady = true;
        const next = focusQueue.shift(); if (next) next();
      } else if (line.startsWith('DONE:')) {
        const cb = focusQueue.shift(); if (cb) cb(line.slice(5));
      }
    }
  });
  focusPs.on('exit', () => { focusPs = null; focusReady = false; });
  focusPs.stdin.write([
    `$ErrorActionPreference='SilentlyContinue'; Add-Type -Path '${FOCUS_DLL}'`,
    `function Focus($n){$p=Get-Process -Name $n -ErrorAction SilentlyContinue|Where-Object{$_.MainWindowHandle -ne 0}|Sort-Object StartTime -Descending|Select-Object -First 1;if(-not $p){Write-Output 'DONE:NOT_RUNNING';return};$h=$p.MainWindowHandle;if([WF]::IsIconic($h)){[WF]::ShowWindow($h,9)|Out-Null};[WF]::keybd_event(0x12,0,0,[UIntPtr]::Zero);[WF]::keybd_event(0x12,0,2,[UIntPtr]::Zero);[WF]::SetForegroundWindow($h)|Out-Null;[WF]::BringWindowToTop($h)|Out-Null;Start-Sleep -Milliseconds 80;[WF]::SetForegroundWindow($h)|Out-Null;Write-Output ('DONE:OK:'+$p.Id)}`,
    `Write-Output 'READY'`,
  ].join('\r\n') + '\r\n');
}
function focusAppCall(procName, cb) {
  ensureFocusDll().then(() => {
    if (!focusPs) initFocusPs();
    if (focusReady) {
      focusQueue.push(cb);
      focusPs.stdin.write(`Focus '${procName}'\r\n`);
    } else {
      focusQueue.push(() => { focusQueue.push(cb); focusPs.stdin.write(`Focus '${procName}'\r\n`); });
    }
  });
}
const ADAPTERS = [claude, codex, workbuddy, deepseek, marvis, doubao, zcode, pi];
// 全局安装锁：同时只允许一个安装任务（installAgent 内部是阻塞的 spawnSync，
// 多个并发跑会互相抢终端输出、也没法在 UI 上清晰呈现进度）。
// 内存态，server 重启自动清零，不会出现「永久卡在进行中」。
let installInProgress = false;

// ---------- SSE 客户端管理 ----------
const sseClients = new Set();
function sseBroadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch { sseClients.delete(res); }
  }
}

// ---------- 采集调度 ----------
let isScanning = false;
const SCAN_DAYS = 30;          // 首次只扫近 30 天，老文件由增量/rescan 补齐
const BIG_FILE = 2 * 1024 * 1024;   // 大于 2MB 的文件只取末尾（最近消息）
async function scanAll() {
  if (isScanning) return;
  isScanning = true;
  const cutoff = Date.now() - SCAN_DAYS * 24 * 3600 * 1000;
  const jobs = [];
  for (const a of ADAPTERS) {
    if (!fs.existsSync(a.ROOT)) continue;
    for (const f of watcher.collectFiles(a.ROOT, a.isSessionFile)) {
      const mtime = watcher.fileMtime(f);
      if (mtime < cutoff) continue; // 老文件跳过，等增量或手动 rescan
      jobs.push({ adapter: a, file: f });
    }
  }
  // 按修改时间倒序：最近的对话先入库，看板秒出数据
  jobs.sort((x, y) => watcher.fileMtime(y.file) - watcher.fileMtime(x.file));
  let total = 0;
  const now = Date.now();
  for (let i = 0; i < jobs.length; i += 5) {
    const batch = jobs.slice(i, i + 5);
    store.tx(() => {
      for (const j of batch) {
        const key = `offset:${j.adapter.ID}:${j.file}`;
        const offset = Number(store.stmts.getMeta.get(key)?.v || 0);
        const size = watcher.fileSize(j.file);
        let lines = [], newOffset = offset;
        if (j.adapter.readFile) {
          // 自定义读取（如 zstd 压缩文件），offset 语义由 adapter 自行解释（通常是行号）
          const t = j.adapter.readFile(j.file, offset);
          lines = t.lines; newOffset = t.newOffset;
        } else if (offset >= size) {
          continue; // 已消费完
        } else if (size > BIG_FILE) {
          // 大文件：始终从 0 全量读取（readAll 循环读完，消息按 source_id 幂等覆盖，不会重复）。
          // 不能用增量：旧 offset 可能停在文件中部，前面的历史永远读不到。
          const t = watcher.readAll(j.file, 0);
          lines = t.lines; newOffset = t.newOffset;
        } else {
          const t = watcher.tailRead(j.file, offset, 1024 * 1024);
          lines = t.lines; newOffset = t.newOffset;
        }
        if (lines.length) {
          for (const m of j.adapter.parseLines(lines, j.file)) { store.ingest(m); total++; }
        }
        store.stmts.setMeta.run(key, String(newOffset));
      }
    });
    const done = Math.min(i + 5, jobs.length);
    if (done % 25 === 0 || done === jobs.length) {
      console.log(`[scan] ${done}/${jobs.length} 文件，+${total} 条`);
      sseBroadcast('scan', { done, total: jobs.length });
    }
    await new Promise((r) => setImmediate(r)); // 让出事件循环，HTTP 保持响应
  }
  // 处理"非文件型"数据源（自带 scanAll，如 Marvis SQLite）：per-file 循环走不到它们
  for (const a of ADAPTERS) {
    if (!fs.existsSync(a.ROOT)) continue;
    if (jobs.some((j) => j.adapter === a)) continue;
    if (typeof a.scanAll === 'function') {
      try {
        const c = a.scanAll(store);
        if (c > 0) { total += c; console.log(`[${a.ID}] +${c} 条`); sseBroadcast('message', { agent: a.ID, count: c }); }
      } catch (e) { console.error(`[${a.ID}] scanAll failed:`, e.message); }
    }
  }
  try { workbuddy.scanHeartbeats(store); } catch { /* ignore */ }
  isScanning = false;
  console.log(`[scan] 完成 ${jobs.length} 个文件，入库 ${total} 条，耗时 ${((Date.now() - now) / 1000).toFixed(1)}s`);
  sseBroadcast('scan', { done: jobs.length, total: jobs.length, finished: true });
  sseBroadcast('active', store.getActive());
}

function pollChanged(adapter, paths) {
  const deleted = [];
  const live = [];
  for (const p of paths) {
    if (fs.existsSync(p)) { live.push(p); continue; }
    // 源文件被删除：仅对会话文件做同步删除（忽略心跳等 .json）
    if (adapter.isSessionFile && !adapter.isSessionFile(p)) continue;
    const sid = adapter.fileToSessionId ? adapter.fileToSessionId(p) : null;
    if (sid) {
      const n = store.deleteSessionByRef(adapter.ID, sid);
      if (n) deleted.push({ agent: adapter.ID, sessionId: sid });
      store.stmts.setMeta.run(`offset:${adapter.ID}:${p}`, '0');
    }
  }
  try {
    if (live.length) {
      const n = store.tx(() => adapter.poll(store, live));
      if (n > 0) {
        console.log(`[${adapter.ID}] +${n} 条`);
        sseBroadcast('message', { agent: adapter.ID, count: n });
      }
    }
  } catch (e) { console.error(`[${adapter.ID}] 增量解析失败:`, e.message); }
  if (deleted.length) {
    console.log(`[${adapter.ID}] 源文件删除，移除 ${deleted.length} 个会话`);
    sseBroadcast('hide', { sessions: deleted });
  }
}

function startWatchers() {
  const stops = [];
  for (const a of ADAPTERS) {
    if (!fs.existsSync(a.ROOT)) continue;
    stops.push(watcher.watchTree(a.ROOT, (p) => pollChanged(a, [p])));
  }
  // WorkBuddy 心跳目录：轮询（文件每秒都在变，watch 事件太密）。
  // 只更新 activeMap，不在此推送 active 事件——统一由下方 5s 定时器推送 getActive()，
  // 避免两个定时器推送不一致快照（含 active:false 条目）导致前端状态每 5 秒来回闪。
  const hbTimer = setInterval(() => {
    try {
      workbuddy.scanHeartbeats(store);
    } catch { /* ignore */ }
  }, 5000);
  // DeepSeek Harness 兜底重扫：fs.watch 在 Windows 上对深层嵌套的 .zstd 文件偶发漏事件
  // （目录刚被创建时收到 change，子文件事件可能在监听器初始化前就过去了），
  // 每 30 秒调 adapter 自身的 scanAll（增量、按 offset）补全漏掉的新会话，避免整个
  // DeepSeek 列在 board 上一直空着。其它 adapter 也已经走 fs.watch，但 deepseek 的
  // session 路径最深（~/.dsh/sessions/<workspace>/session-<uuid>/），命中率最低。
  const dsTimer = setInterval(() => {
    try {
      const c = deepseek.scanAll(store);
      if (c > 0) {
        console.log(`[deepseek] (fallback) +${c} 条`);
        sseBroadcast('message', { agent: 'deepseek', count: c });
      }
    } catch { /* ignore */ }
  }, 30 * 1000);
  // ZCode SQLite WAL 兜底重扫：fs.watch 对 WAL 文件写入偶发漏事件（checkpoint 时文件可能被
  // 短暂重命名/重建，监听器容易丢事件），每 30 秒调 adapter 自身 scanAll（sequence 增量、开销小）
  // 补全漏掉的新消息，避免 ZCode 列实时性差。
  const zcTimer = setInterval(() => {
    try {
      const c = zcode.scanAll(store);
      if (c > 0) {
        console.log(`[zcode] (fallback) +${c} 条`);
        sseBroadcast('message', { agent: 'zcode', count: c });
      }
    } catch { /* ignore */ }
  }, 30 * 1000);
  // WorkBuddy 桌面会话「停顿检测」：桌面对话（UUID）心跳一次性写入、无法用心跳停止提前完成，
  // 但 jsonl 只写已完成消息 → 文件静止 + 末条为 assistant = agent 停笔 → 提前结束「进行中」。
  // （CLI host 会话已由 hbTimer 的心跳跟踪覆盖，这里只处理桌面会话，见 checkDesktopIdle 内部判定）
  // Codex 会话「1 分钟停顿检测」：Codex Windows 桌面 hook 框架有 bug（hooks.json/inline 都失败），
  // 改用文件停顿检测（idle-check.js）：rollout 静止 >60s + 末条 assistant → 写 doneSignalAt（等价 signal-done.js）。
  const deskTimer = setInterval(() => {
    try {
      workbuddy.checkDesktopIdle(store);
      idleCheck.checkCodexIdle(store);
    } catch { /* ignore */ }
  }, 20 * 1000);
  // CLI agent 进程检查：「进行中」= 最后真实消息 10 分钟窗口，但 CLI 任务跑完进程即退出——
  // 进程全无 = 该 agent 一定不在运行 → 提前结束「进行中」（不必等满 10 分钟）。
  // 只在进程名精确确认的 agent 上启用（进程名匹配不全时宁可保守不判，避免误伤正在运行的会话）。
  const procTimer = setInterval(checkAgentProcesses, 30 * 1000);
  return () => { for (const s of stops) s(); clearInterval(hbTimer); clearInterval(dsTimer); clearInterval(zcTimer); clearInterval(deskTimer); clearInterval(procTimer); };
}

// CLI agent 进程名 → 进程检查。仅收录已实测确认的 exe 名；匹配不到进程 = 该 agent 全部 session 提前 done
const PROC_PATTERNS = {
  claude: ['claude.exe'],
  codex: ['codex.exe'],
  zcode: ['zcode.exe'],
  // pi / deepseek-harness 进程名未实测确认，暂不启用（保守）
};
function checkAgentProcesses() {
  let text;
  try {
    const r = spawnSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    if (r.error || r.status !== 0) return;
    text = (r.stdout || '').toLowerCase();
  } catch { return; }
  const now = Date.now();
  for (const [agent, patterns] of Object.entries(PROC_PATTERNS)) {
    const alive = patterns.some((p) => text.includes(p));
    // alive → 进程在，清除停止标记（可能 resume）；进程全无 → 该 agent 所有窗口内 session 提前完成
    store.setAgentStopped(agent, !alive, now);
  }
}

// 定时推送活跃会话快照（3 分钟窗口的"正在进行"）
setInterval(() => {
  sseBroadcast('active', store.getActive());
}, 5000);

// ---------- HTTP 服务 ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, urlPath) {
  let p = path.normalize(path.join(PUBLIC, urlPath === '/' ? 'index.html' : urlPath));
  if (!p.startsWith(PUBLIC)) { res.writeHead(403); res.end(); return; }
  fs.readFile(p, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
    res.end(data);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => { buf += c; if (buf.length > 10 * 1024 * 1024) req.destroy(); });
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // SSE
  if (pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`event: hello\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);
    res.write(`event: active\ndata: ${JSON.stringify(store.getActive())}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  // 总览状态
  if (pathname === '/api/state') {
    const agents = store.stmts.agents.all().map((r) => ({
      id: r.agent, name: store.agentMeta(r.agent).name, color: store.agentMeta(r.agent).color, cnt: r.cnt,
    }));
    const projects = store.stmts.projects.all();
    const range = url.searchParams.get('range') || 'day';
    const active = store.getRecentActive(range);
    const stats = store.getStats();
    // 顶栏"活跃会话"用"现在 live"数（与 /api/board 的 liveRefs、前端卡片绿框一致），
    // 而不是 getRecentActive 的全部命中数（后者包括今天活过但已停下来的）。
    // live 字段已统一为「最后真实消息 < 10 分钟」（lastMsgAt），不再被心跳保活顶起。
    stats.active = active.filter((s) => s.live).length;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ stats, agents, projects, active, agentsDef: AGENT_DEFS }));
    return;
  }

  // 顶栏/跳转：未运行则启动，运行中则激活窗口
  if (pathname === '/api/launch-agent' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const agent = String(body.agent || '');
      if (!AGENT_DEFS[agent]) throw new Error('未知 agent: ' + agent);
      launchOrFocus(agent, (r) => {
        console.log(`[launch-agent] ${agent} ->`, JSON.stringify(r));
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, agent }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // 时间线（倒序分页）
  if (pathname === '/api/timeline') {
    const q = {
      agent: url.searchParams.get('agent') || '',
      project: url.searchParams.get('project') || '',
      q: url.searchParams.get('q') || '',
      cursor: Number(url.searchParams.get('cursor') || 0),
      limit: Number(url.searchParams.get('limit') || 100),
    };
    const items = store.getTimeline(q).map((r) => ({ ...r, text: (r.text || '').slice(0, 4000) }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ items, cursor: items.length ? items[items.length - 1].ts : 0 }));
    return;
  }

  // 会话详情
  if (pathname.startsWith('/api/session/')) {
    try {
      const ref = decodeURIComponent(pathname.slice('/api/session/'.length));
      if (!ref || ref.length > 500) { res.writeHead(400); res.end(JSON.stringify({ error: 'invalid ref' })); return; }
      const s = store.getSession(ref);
      if (!s) { res.writeHead(404); res.end(JSON.stringify({ error: 'session not found' })); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(s));
    } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message || 'server error' })); }
    return;
  }

  // 会话列表（按 session 卡片用）
  if (pathname === '/api/sessions') {
    const items = store.getSessions({
      agent: url.searchParams.get('agent') || '',
      project: url.searchParams.get('project') || '',
      q: url.searchParams.get('q') || '',
      cursor: Number(url.searchParams.get('cursor') || 0),
      limit: Number(url.searchParams.get('limit') || 100),
      onlyUser: url.searchParams.get('onlyUser') === '1',
    });
    const cursor = items.length ? items[items.length - 1].last_seen : 0;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ items, cursor }));
    return;
  }

  // 瀑布流看板：按 agent 分组返回 sessions（列动态化：AGENT_DEFS + 实际有数据的 agent）
  if (pathname === '/api/board') {
    // range：0=全部；1=今天（本地 0:00 起）；-1=最近 24 小时（now-24h 滑窗）；N=近 N 天
    const range = Number(url.searchParams.get('range') || 0);
    let since = 0;
    if (range === 1) { const d = new Date(); d.setHours(0, 0, 0, 0); since = d.getTime(); }
    else if (range === -1) since = Date.now() - 24 * 3600 * 1000;
    else if (range > 1) since = Date.now() - range * 24 * 3600 * 1000;
    const qBase = {
      project: url.searchParams.get('project') || '',
      q: url.searchParams.get('q') || '',
      onlyUser: url.searchParams.get('onlyUser') === '1',
      limit: Number(url.searchParams.get('limit') || 80),
      since,
    };
    const groups = {
      all: store.getSessions({ ...qBase, agent: '' }),
    };
    // 动态列：AGENT_DEFS 定义顺序优先，再补 store 实际存在的 agent（如手动导入的自定义名）
    const agentIds = new Set();
    for (const id of Object.keys(AGENT_DEFS)) agentIds.add(id);
    for (const a of store.stmts.agents.all()) if (a.agent) agentIds.add(a.agent);
    for (const id of agentIds) {
      groups[id] = store.getSessions({ ...qBase, agent: id });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    // liveRefs：当前实时活跃的 session ref 集合（getActive 按 10 分钟窗口），供前端渲染状态用
    res.end(JSON.stringify({
      groups, agentIds: [...agentIds],
      liveRefs: store.getActive().map((a) => a.sessionRef),
    }));
    return;
  }

  // 一键跳转到 AI agent 的该 session（开新终端窗口 + cd + 跑 resume）
  if (pathname === '/api/open-with' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const agent = String(body.agent || '');
      const sessionId = String(body.sessionId || '');
      const project = String(body.project || '');
      // 安全校验：agent 在白名单；sessionId 必须是 sessions 表里已有的；project 必须是该 session 记录的 project
      if (!['claude', 'codex', 'workbuddy'].includes(agent)) throw new Error('不支持的 agent');
      if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(sessionId)) throw new Error('sessionId 非法');
      if (!/^[A-Za-z0-9:\\/.\-_ \u4e00-\u9fff]{1,500}$/.test(project)) throw new Error('project 路径非法');
      const sid = agent + ':' + sessionId;
      const s = store.getSession(sid);
      if (!s) throw new Error('session 不存在');
      if (project && s.project !== project) throw new Error('project 与 session 不匹配');
      // 构造 resume 命令
      let innerCmd;
      if (agent === 'claude') innerCmd = `claude --resume ${sessionId}`;
      else if (agent === 'codex') innerCmd = `codex resume ${sessionId}`;
      else innerCmd = `echo 此 agent 无 CLI 恢复命令，请打开 ${project || s.project} 目录`;
      const quotedPath = '"' + project.replace(/"/g, '') + '"';
      // 用 cmd /c start 开新窗口，/K 保持窗口；外层 cmd /c 启动后即退出
      const full = `start "Agent Board" cmd /K "cd /d ${quotedPath} && ${innerCmd}"`;
      exec(full, { shell: 'cmd.exe', windowsHide: false }, (err) => {
        if (err) console.error('[open-with] exec 失败:', err.message);
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, command: full }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // 激活桌面端应用窗口（用户主力是桌面 AI 客户端）
  // 快路径：加载预编译 WF.dll（毫秒级）+ Win32 组合拳突破前台锁定
  if (pathname === '/api/focus-app' && req.method === 'POST') {
    const PROC = { claude: 'claude', codex: 'Codex', workbuddy: 'WorkBuddy', doubao: 'Doubao' };
    const SCHEME = { claude: 'claude://', codex: 'codex://', workbuddy: 'workbuddy://', doubao: 'doubao://' };
    try {
      const body = await readBody(req);
      const agent = String(body.agent || '');
      const procName = PROC[agent];
      if (!procName) throw new Error('不支持的 agent');
      const t0 = Date.now();
      focusAppCall(procName, (result) => {
        console.log(`[focus-app] ${agent} -> ${result || '?'} (${Date.now() - t0}ms)`);
        // 冷启动：进程不在，用 URL scheme 拉起（慢路径，罕见）
        if (result === 'NOT_RUNNING') {
          const scheme = SCHEME[agent];
          if (scheme) exec(`start "" "${scheme}"`, { shell: 'cmd.exe', windowsHide: true }, () => {});
        }
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, agent, procName }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // 隐藏会话（黑名单）：即便源文件仍在也持续不在看板显示，可恢复
  // 手动设置会话状态：done=标记已完成并关闭心跳（心跳扫描跳过）；auto=恢复自动判定
  if (pathname === '/api/set-status' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const status = String(body.status || '');
      if (!['done', 'auto'].includes(status)) throw new Error('status 必须是 done 或 auto');
      const r = store.setManualStatus(String(body.agent || ''), String(body.sessionId || ''), status);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, status: r }));
      // 立即推送最新活跃快照，前端 liveRefs 马上更新（手动 done 的会话立即从进行中消失）
      sseBroadcast('active', store.getActive());
    } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
    return;
  }

  // Agent 完成信号：各 AI agent（Claude Code Stop hook / Codex Stop hook / 全局约束文件指令）在
  // 完成本轮最后输出时静默调用 → 立即结束该会话的「进行中」（不再等 10 分钟窗口）。
  // 幂等：重复信号无害；新真实消息（ingest）会自动清除该停止标记，会话重新参与判定。
  if (pathname === '/api/complete' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const agent = String(body.agent || '').trim();
      const sessionId = String(body.sessionId || '').trim();
      if (!agent) throw new Error('缺少 agent');
      const ref = store.resolveAgentRef(agent, sessionId);
      if (!ref) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'no matching session', agent, sessionId }));
        return;
      }
      // 完成信号使用独立的 doneSignalAt（持久化）：agent 明确声明本轮结束 →
      // 立即结束「进行中」；只有晚于信号时刻的新真实消息才能解除（ingest 内做 ts 比较），
      // 进程检查 / 心跳 / 停顿检测都不会覆盖它（避免 codex 常驻进程把状态顶回进行中）。
      store.setDoneSignal(ref, Date.now());
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ref }));
      sseBroadcast('active', store.getActive());
    } catch (e) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
    return;
  }

  if (pathname === '/api/hide' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      store.hideSession(body.agent, body.sessionId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      sseBroadcast('hide', { sessions: [{ agent: body.agent, sessionId: body.sessionId }] });
    } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
    return;
  }
  // 恢复已隐藏的会话
  if (pathname === '/api/unhide' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      store.unhideSession(body.agent, body.sessionId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      sseBroadcast('unhide', { sessions: [{ agent: body.agent, sessionId: body.sessionId }] });
    } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
    return;
  }
  // 列出已隐藏的会话（管理/恢复用）
  if (pathname === '/api/hidden' && req.method === 'GET') {
    try {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ items: store.listHidden() }));
    } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
    return;
  }

  // 手动导入（豆包等无本地数据的 agent）
  if (pathname === '/api/import' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const agent = body.agent || 'other';
      const sessionId = body.sessionId || crypto.randomUUID();
      const project = body.project || '';
      const title = body.title || '';
      const msgs = Array.isArray(body.messages) ? body.messages : [];
      let n = 0;
      msgs.forEach((m, i) => {
        const ts = m.timestamp ? (typeof m.timestamp === 'number' ? m.timestamp : Date.parse(m.timestamp) || Date.now()) : Date.now();
        const text = (m.content || m.text || '').trim();
        if (!text) return;
        store.ingest({
          agent, sourceId: `${sessionId}:import:${i}`, sessionId, ts,
          role: (m.role === 'user' || m.role === 'assistant') ? m.role : 'assistant',
          kind: 'message', text, project, title,
        });
        n++;
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, imported: n }));
      sseBroadcast('message', { agent, count: n });
    } catch (e) {
      res.writeHead(400); res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // 手动触发全量扫描（重置偏移，重新解析）
  // 异步执行：立即返回 200（避免前端 fetch 阻塞 20+ 秒造成"点击没反应"的错觉），
  // 扫描完成通过 SSE 'scan' 事件通知前端刷新。
  if (pathname === '/api/rescan' && req.method === 'POST') {
    if (isScanning) {
      // 初始扫描进行中：不能清表（否则数据被清空但 scanAll 静默跳过 → board 全空）
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: '初始扫描进行中，请稍后再试' }));
      return;
    }
    // 立即响应，后台执行
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, background: true }));
    // 稍等一帧让响应先发出，再开始后台重建
    setTimeout(async () => {
      try {
        // 清表全量重建：last_seen 可能已被旧解析器污染（MAX 只增不减），必须重建才能修正
        store.clearAll();
        await scanAll();
        // 修复 custom-title 先创建导致 first_seen=0 的会话
        store.repairSessionTimestamps();
        store.repairUserQueries();
        sseBroadcast('active', store.getRecentActive('day'));
        console.log('[rescan] 完成');
      } catch (e) {
        console.error('[rescan] failed:', e.message);
      }
    }, 50);
    return;
  }

  // 应用探测：返回每个 agent 的安装/探测状态（设置页"应用管理"用）
  if (pathname === '/api/agents/status') {
    try {
      const probed = await detect.probeAll(ADAPTERS);
      const byId = Object.fromEntries(ADAPTERS.map((a) => [a.ID, a]));
      const agents = {};
      for (const [id, r] of Object.entries(probed)) {
        const meta = AGENT_DEFS[id] || {};
        // install 数据透传给前端：渲染「安装」按钮的确认弹窗要用（要跑什么命令、有什么警告）
        const def = (byId[id] && byId[id].detect) || {};
        agents[id] = {
          ...r,
          name: meta.name || id, icon: meta.icon || '', color: meta.color || '#888',
          install: def.install ? { ...def.install, picked: detect.pickMethod(def.install.methods || [], process.platform) } : null,
        };
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ agents }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message || 'probe failed' }));
    }
    return;
  }

  // 安装某个 agent（只支持 tier:'cli'）。全局同时只允许一个安装任务在跑。
  // 响应立即返回（参考 /api/rescan 的异步模式），真实进度走 SSE 的 agent-install-progress 事件。
  if (pathname.startsWith('/api/agents/') && pathname.endsWith('/install') && req.method === 'POST') {
    const id = pathname.slice('/api/agents/'.length, -'/install'.length);
    const adapter = ADAPTERS.find((a) => a.ID === id);
    if (!adapter || !adapter.detect) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '未知 agent: ' + id }));
      return;
    }
    if (adapter.detect.tier !== 'cli') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '这一版只支持命令行类工具的自动安装' }));
      return;
    }
    if (installInProgress) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '已有安装任务在进行，请等它结束' }));
      return;
    }
    installInProgress = true;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, background: true }));
    // 让响应先发出去再开跑（installAgent 内部是同步 spawnSync，会阻塞事件循环）
    setTimeout(() => {
      try {
        detect.installAgent(adapter, (step, detail) => {
          sseBroadcast('agent-install-progress', { agentId: id, step, ...detail });
        });
      } catch (e) {
        console.error(`[install] ${id} 未预期的异常:`, e.message);
        sseBroadcast('agent-install-progress', { agentId: id, step: 'failed', reason: e.message || '未知错误' });
      } finally {
        installInProgress = false;
      }
    }, 50);
    return;
  }

  // 静态文件
  if (req.method === 'GET') {
    serveStatic(req, res, pathname);
    return;
  }
  res.writeHead(405); res.end();
});

server.listen(PORT, '127.0.0.1', async () => {
  console.log(`┌──────────────────────────────────────────────┐`);
  console.log(`│  Agent Board · AI Agent 会话看板             │`);
  console.log(`│  打开: http://127.0.0.1:${PORT}                │`);
  console.log(`└──────────────────────────────────────────────┘`);
  ensureFocusDll().then(() => { initFocusPs(); console.log('[focus] 窗口激活进程就绪'); });
  await scanAll();
  // 修复存量数据里的 futCache：adapter 增/改了 system context 过滤规则后，旧入库的"系统注入"
  // 消息仍占着 userMsgFlag / futCache 首位，导致 board title 取到错误内容。重启时显式按
  // 当前 extractUserQuery 重算每会话首条真实用户输入。
  store.repairUserQueries();
  // 服务停机期间已停笔的桌面会话：启动即判一次，无需等首个 20s 定时器
  try { workbuddy.checkDesktopIdle(store); idleCheck.checkCodexIdle(store); } catch { /* ignore */ }
  startWatchers();
  console.log('[watch] 已开始监听:', ADAPTERS.filter((a) => fs.existsSync(a.ROOT)).map((a) => a.ID).join(', '));
});
