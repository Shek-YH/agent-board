'use strict';
// Agent Board 服务器：HTTP 静态 + REST + SSE 实时推送
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { exec, spawn } = require('child_process');
const store = require('./lib/store');
const watcher = require('./lib/watcher');
const claude = require('./lib/adapters/claude');
const codex = require('./lib/adapters/codex');
const workbuddy = require('./lib/adapters/workbuddy');
const deepseek = require('./lib/adapters/deepseek');
const marvis = require('./lib/adapters/marvis');
const doubao = require('./lib/adapters/doubao');

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
const ADAPTERS = [claude, codex, workbuddy, deepseek, marvis, doubao];

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
  return () => { for (const s of stops) s(); clearInterval(hbTimer); };
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
    stats.active = active.length;
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
    // range：0=全部；1=今天；N=近 N 天（与前端 f-range 对齐）
    const range = Number(url.searchParams.get('range') || 0);
    let since = 0;
    if (range === 1) { const d = new Date(); d.setHours(0, 0, 0, 0); since = d.getTime(); }
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
  if (pathname === '/api/rescan' && req.method === 'POST') {
    try {
      // 清表全量重建：last_seen 可能已被旧解析器污染（MAX 只增不减），必须重建才能修正
      store.clearAll();
      await scanAll();
      // 修复 custom-title 先创建导致 first_seen=0 的会话
      store.repairSessionTimestamps();
      sseBroadcast('active', store.getRecentActive('day'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
    }
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
  startWatchers();
  console.log('[watch] 已开始监听:', ADAPTERS.filter((a) => fs.existsSync(a.ROOT)).map((a) => a.ID).join(', '));
});
