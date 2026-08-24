'use strict';
// Agent Board 服务器：HTTP 静态 + REST + SSE 实时推送
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { exec, spawn, spawnSync } = require('child_process');
const store = require('./lib/store');
const account = require('./lib/account');
const { clearAuthCache } = require('./lib/auth-cache');
const soundSettings = require('./lib/sound-settings');
const detect = require('./lib/detect');
const launchLib = require('./lib/launch');
const { buildCodexDeepLink } = require('./lib/codex-deep-link');
const { buildDeepSeekDesktopDeepLink } = require('./lib/deepseek-desktop-deep-link');
const { buildPiAgentDesktopDeepLink } = require('./lib/pi-agent-deep-link');
const { resolvePiAgentDesktopExe } = require('./lib/pi-agent-desktop-path');
const { buildHermesDesktopDeepLink } = require('./lib/hermes-deep-link');
const { resolveHermesDesktopExe } = require('./lib/hermes-desktop-path');
const watcher = require('./lib/watcher');
const claude = require('./lib/adapters/claude');
const codex = require('./lib/adapters/codex');
const workbuddy = require('./lib/adapters/workbuddy');
const deepseek = require('./lib/adapters/deepseek');
const marvis = require('./lib/adapters/marvis');
const zcode = require('./lib/adapters/zcode');
const pi = require('./lib/adapters/pi');
const hermes = require('./lib/adapters/hermes');

const PORT = Number(process.env.AB_PORT || 4876);
const PUBLIC = path.join(__dirname, 'public');
const HERMES_SCAN_INTERVAL_MS = 5 * 1000;

// ---------- Agent 可扩展配置表 ----------
// 新增 agent：加一条定义即可（proc=进程名用于激活；scheme=URL协议用于冷启动拉起；launch=备选启动命令；icon=public/icons 下的图标文件）
const AGENT_DEFS = {
  claude:    { name: 'Claude Code',      color: '#D97757', icon: 'claude.png',    proc: 'claude',    scheme: 'claude://',     launch: null },
  codex:     { name: 'Codex',            color: '#10A37F', icon: 'codex.png',     proc: 'Codex',     scheme: 'codex://',      launch: null },
  workbuddy: { name: 'WorkBuddy',        color: '#3B82F6', icon: 'workbuddy.png', proc: 'WorkBuddy', scheme: 'workbuddy://',  launch: null },
  deepseek:  { name: 'DeepSeek Harness', color: '#4D6BFE', icon: 'deepseek.png',  proc: 'DSHDesktop', scheme: 'dshdesktop://', launch: null,
    launchCmd: '"C:\\Users\\Administrator\\AppData\\Local\\Programs\\DSH Desktop\\DSH Desktop.exe"' },
  marvis:    { name: 'Marvis',           color: '#7C3AED', icon: 'marvis.png',    proc: 'Marvis',    scheme: null,            launch: null,
    launch: '"C:\\Users\\Administrator\\WorkBuddy\\2026-08-20-03-52-10\\agent-board\\marvis-launch.bat"' },
  zcode:     { name: 'ZCode',            color: '#1772F0', icon: 'zcode.png',     proc: 'ZCode',     scheme: null,            launch: null,
    launch: '"C:\\Users\\Administrator\\WorkBuddy\\2026-08-20-03-52-10\\agent-board\\zcode-launch.bat"' },
  pi:        { name: 'Pi Agent',         color: '#01BEBF', icon: 'pi.png',        proc: 'pi',        scheme: null,            launch: null },
  hermes:    { name: 'Hermes Agent',     color: '#F59E0B', icon: 'hermes.png',    proc: 'hermes-agent', scheme: 'hermes://', launch: null },
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

  // 模型端口设置：用户配置了自定义启动命令，直接跑这条命令，不走下面任何默认逻辑。
  // 不做"是否已运行"检测——覆盖命令是用户自己指定的任意程序，没法通用地判断它是否已经在跑，
  // 交给用户自己选的程序/脚本自己处理，这里只负责"跑一下"。
  const override = launchLib.loadLaunchOverrides()[agent];
  if (override) {
    spawn('cmd.exe', ['/c', override], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
    cb({ ok: true, action: 'launch-override', agent });
    return;
  }

  // Hermes Desktop 可能尚未向 Windows 注册 hermes:// 协议；顶栏启动只需要
  // 打开应用本身，直接传可执行文件路径，避免把协议交给系统 Shell 解析。
  if (agent === 'hermes') {
    const desktopExe = resolveHermesDesktopExe();
    if (process.platform === 'win32' && !fs.existsSync(desktopExe)) {
      cb({ ok: false, error: `未找到 Hermes Desktop：${desktopExe}` });
      return;
    }
    try {
      spawn(desktopExe, [], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
      cb({ ok: true, action: 'launch', agent });
    } catch (e) {
      cb({ ok: false, error: e.message || '启动 Hermes Desktop 失败', agent });
    }
    return;
  }

  // Pi Agent 顶栏入口打开桌面端，不再把命令行版 pi 的 Web UI 当成默认目标。
  if (agent === 'pi') {
    const desktopExe = resolvePiAgentDesktopExe();
    if (process.platform === 'win32' && !fs.existsSync(desktopExe)) {
      cb({ ok: false, error: `未找到 Pi Agent Desktop：${desktopExe}` });
      return;
    }
    try {
      spawn(desktopExe, [], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
      cb({ ok: true, action: 'launch', agent });
    } catch (e) {
      cb({ ok: false, error: e.message || '启动 Pi Agent Desktop 失败', agent });
    }
    return;
  }

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
function focusHermesWindow(attempt = 0) {
  focusAppCall('Hermes', (result) => {
    if (result === 'NOT_RUNNING' && attempt < 10) {
      setTimeout(() => focusHermesWindow(attempt + 1), 150);
      return;
    }
    console.log(`[open-hermes-session] focus Hermes -> ${result || '?'}`);
  });
}
const ADAPTERS = [claude, codex, workbuddy, deepseek, marvis, zcode, pi, hermes];
store.migrateCodexCompletionSignals();
// 全局安装锁：同时只允许一个安装任务（installAgent 内部是阻塞的 spawnSync，
// 多个并发跑会互相抢终端输出、也没法在 UI 上清晰呈现进度）。
// 内存态，server 重启自动清零，不会出现「永久卡在进行中」。
let installInProgress = false;

// 探测结果缓存：5 分钟 TTL。避免 /api/board（首页高频调用）每次都触发一次完整探测
// （registry 查询 + 逐个 agent spawnSync 查版本号）。安装成功时主动失效，不等 TTL。
const PROBE_CACHE_TTL_MS = 5 * 60 * 1000;
let probeCache = { data: null, ts: 0 };
async function getProbe(force = false) {
  if (!force && probeCache.data && Date.now() - probeCache.ts < PROBE_CACHE_TTL_MS) {
    return probeCache.data;
  }
  const data = await detect.probeAll(ADAPTERS);
  probeCache = { data, ts: Date.now() };
  return data;
}

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
          const msgs = j.adapter.parseLines(lines, j.file);
          for (const m of msgs) { store.ingest(m); total++; }
          if (j.adapter.ID === 'codex') {
            const last = msgs[msgs.length - 1];
            const sourceTs = lines.reduce((latest, line) => Math.max(latest, Date.parse(line.timestamp) || 0), 0);
            store.noteCodexActivity(`codex:${j.adapter.fileToSessionId(j.file)}`, sourceTs, { agent: 'codex', project: (last && last.project) || '' });
          }
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
  try {
    const titleCount = codex.syncSessionTitles(store);
    if (titleCount > 0) {
      total += titleCount;
      console.log(`[codex] 同步 ${titleCount} 个会话标题`);
      sseBroadcast('message', { agent: 'codex', count: titleCount });
    }
  } catch (e) { console.error('[codex] session_index 同步失败:', e.message); }
  try { workbuddy.scanHeartbeats(store); } catch { /* ignore */ }
  isScanning = false;
  console.log(`[scan] 完成 ${jobs.length} 个文件，入库 ${total} 条，耗时 ${((Date.now() - now) / 1000).toFixed(1)}s`);
  sseBroadcast('scan', { done: jobs.length, total: jobs.length, finished: true });
  sseBroadcast('active', { active: store.getActive(), statuses: store.getRuntimeStatuses() });
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
  // WorkBuddy 心跳目录 + 本地 SQLite 会话状态：轮询（文件每秒都在变，watch 事件太密）。
  // 只更新内部状态，不在此推送 active 事件——统一由下方 5s 定时器推送 getActive()，
  // 避免两个定时器推送不一致快照（含 active:false 条目）导致前端状态每 5 秒来回闪。
  const hbTimer = setInterval(() => {
    try {
      workbuddy.scanHeartbeats(store);
    } catch { /* ignore */ }
  }, 5000);
  // Codex 的重命名写入 ~/.codex/session_index.jsonl，而不是 rollout 日志；
  // 轻量 stat 轮询能在文件变化后及时把最新标题同步到看板。
  const codexTitleTimer = setInterval(() => {
    try {
      const c = codex.syncSessionTitles(store);
      if (c > 0) {
        console.log(`[codex] session_index 更新 ${c} 个标题`);
        sseBroadcast('message', { agent: 'codex', count: c });
      }
    } catch (e) { console.error('[codex] session_index 增量同步失败:', e.message); }
  }, 1000);
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
  // Hermes SQLite WAL 兜底重扫：state.db 在 checkpoint 时可能重命名 WAL，
  // Windows fs.watch 偶发漏事件；每 5 秒读取消息和 session 终态字段，开销可控。
  const hermesTimer = setInterval(() => {
    try {
      const c = hermes.scanAll(store);
      if (c > 0) {
        console.log(`[hermes] (fallback) +${c} 条`);
        sseBroadcast('message', { agent: 'hermes', count: c });
      }
    } catch { /* ignore */ }
  }, HERMES_SCAN_INTERVAL_MS);
  // 桌面会话「停顿检测」：WorkBuddy / DeepSeek 都不能用常驻桌面进程判断某张卡是否仍在跑，
  // 由各自 adapter 用「文件静止 + 最后一条 assistant 消息」提前结束「进行中」。
  const deskTimer = setInterval(() => {
    try {
      workbuddy.checkDesktopIdle(store);
      deepseek.checkDesktopIdle(store);
    } catch { /* ignore */ }
  }, 20 * 1000);
  // CLI agent 进程检查：「进行中」= 最后真实消息 10 分钟窗口，但 CLI 任务跑完进程即退出——
  // 进程全无 = 该 agent 一定不在运行 → 提前结束「进行中」（不必等满 10 分钟）。
  // 只在进程名精确确认的 agent 上启用（进程名匹配不全时宁可保守不判，避免误伤正在运行的会话）。
  const procTimer = setInterval(checkAgentProcesses, 30 * 1000);
  return () => { for (const s of stops) s(); clearInterval(hbTimer); clearInterval(codexTitleTimer); clearInterval(dsTimer); clearInterval(zcTimer); clearInterval(hermesTimer); clearInterval(deskTimer); clearInterval(procTimer); };
}

// CLI agent 进程名 → 进程检查。仅收录已实测确认的 exe 名；匹配不到进程 = 该 agent 全部 session 提前 done
const PROC_PATTERNS = {
  claude: ['claude.exe'],
  // Codex Desktop 的实际宿主进程不稳定（当前版本不一定叫 codex.exe），
  // 不能用进程名缺失强制结束会话；Codex 以 JSONL 日志和 task_complete 判定为准。
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
  if (!isScanning) sseBroadcast('active', { active: store.getActive(), statuses: store.getRuntimeStatuses() });
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
  '.aac': 'audio/aac',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
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
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch (error) { reject(error); } });
    req.on('error', reject);
  });
}

function readAudioBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let byteLength = 0; let settled = false;
    req.on('data', (chunk) => {
      if (settled) return;
      byteLength += chunk.length;
      if (byteLength > 12 * 1024 * 1024) {
        settled = true;
        const error = new Error('Request body too large'); error.statusCode = 413;
        req.resume(); reject(error); return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (error) { reject(error); }
    });
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
    res.write(`event: active\ndata: ${JSON.stringify({ active: store.getActive(), statuses: store.getRuntimeStatuses() })}\n\n`);
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

  // 账号权益状态：仅返回安全摘要，绝不返回令牌或公钥。
  if (pathname === '/api/account/status' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(account.getAccountStatus()));
    return;
  }

  // 退出登录只清除独立的账号缓存，不触及本地会话或其他设置。
  if (pathname === '/api/account/logout' && req.method === 'POST') {
    try {
      clearAuthCache();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(account.getAccountStatus()));
    } catch {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unable to clear account cache' }));
    }
    return;
  }

  if (pathname === '/api/sounds' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(soundSettings.loadSoundSettings()));
    return;
  }

  if (pathname === '/api/sounds/upload' && req.method === 'POST') {
    try {
      const body = await readAudioBody(req);
      const sound = soundSettings.uploadSound({ dataUrl: body.dataUrl, name: body.name });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sound, settings: soundSettings.loadSoundSettings() }));
    } catch (error) {
      const badInput = error instanceof TypeError || error instanceof RangeError || error instanceof SyntaxError || error.statusCode === 413;
      res.writeHead(error.statusCode === 413 ? 413 : (badInput ? 400 : 500), { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.statusCode === 413 ? 'Audio upload is too large' : (badInput ? 'Invalid audio upload' : 'Unable to save audio upload') }));
    }
    return;
  }

  if (pathname.startsWith('/api/sounds/') && req.method === 'DELETE') {
    try {
      const soundId = decodeURIComponent(pathname.slice('/api/sounds/'.length));
      if (!soundId || soundId.includes('/')) throw new TypeError('Invalid sound id');
      const settings = soundSettings.deleteSound(soundId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(settings));
    } catch (error) {
      const badInput = error instanceof TypeError || error instanceof RangeError || error instanceof URIError;
      res.writeHead(badInput ? 400 : 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: badInput ? 'Invalid sound deletion' : 'Unable to delete sound' }));
    }
    return;
  }

  if (pathname === '/api/sounds/assign' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const agent = String(body.agent || '');
      if (!Object.hasOwn(AGENT_DEFS, agent)) throw new TypeError('Invalid agent');
      const soundId = typeof body.soundId === 'string' ? body.soundId : '';
      const settings = soundSettings.assignSound(agent, soundId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(settings));
    } catch (error) {
      const badInput = error instanceof TypeError || error instanceof RangeError || error instanceof SyntaxError || error.statusCode === 413;
      res.writeHead(error.statusCode === 413 ? 413 : (badInput ? 400 : 500), { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: badInput ? 'Invalid sound assignment' : 'Unable to save sound assignment' }));
    }
    return;
  }

  // 按 threadId 打开指定 Codex 会话。只接受固定格式的 ID，不接受任意 URL。
  if (pathname === '/api/open-codex-thread' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const threadId = body && body.threadId;
      const deepLink = buildCodexDeepLink(threadId);
      if (process.platform !== 'win32') throw new Error('当前本地 Agent 只支持 Windows Codex 深链');
      spawn('cmd.exe', ['/c', 'start', '', deepLink], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, threadId }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message || '无法打开 Codex 会话' }));
    }
    return;
  }

  // 按 sessionId 打开已安装的 DeepSeek Harness Desktop。优先直接传参给
  // 已安装的 Electron 可执行文件：这样即使协议尚未被旧版本注册，也能
  // 由 Electron 的单实例 second-instance 接收 dshdesktop URI。
  if (pathname === '/api/open-deepseek-session' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const sessionId = String(body.sessionId || '');
      const deepLink = buildDeepSeekDesktopDeepLink(sessionId);
      const session = store.getSession(`deepseek:${sessionId}`);
      if (!session) throw new Error('DeepSeek session 不存在');
      const desktopExe = path.join(require('os').homedir(), 'AppData', 'Local', 'Programs', 'DSH Desktop', 'DSH Desktop.exe');
      if (process.platform === 'win32' && fs.existsSync(desktopExe)) {
        spawn(desktopExe, [deepLink], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
      } else if (process.platform === 'darwin') {
        spawn('open', [deepLink], { detached: true, stdio: 'ignore' }).unref();
      } else {
        spawn('xdg-open', [deepLink], { detached: true, stdio: 'ignore' }).unref();
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, sessionId }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message || '无法打开 DeepSeek Desktop 会话' }));
    }
    return;
  }

  // 按 Pi Agent sessionId 打开已安装的桌面端。直接把 URI 作为第二次启动
  // 参数传给 Tauri 可执行文件，由 single-instance 转发给主实例。
  if (pathname === '/api/open-pi-agent-session' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const requestedSessionId = String(body.sessionId || '');
      const sessionId = pi.resolveSessionId(requestedSessionId);
      const deepLink = buildPiAgentDesktopDeepLink(sessionId);
      if (!store.getSession(`pi:${requestedSessionId}`) && !store.getSession(`pi:${sessionId}`)) {
        throw new Error('Pi Agent session 不存在');
      }
      const desktopExe = resolvePiAgentDesktopExe();
      if (process.platform === 'win32' && fs.existsSync(desktopExe)) {
        spawn(desktopExe, [deepLink], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
      } else if (process.platform === 'darwin') {
        spawn('open', [deepLink], { detached: true, stdio: 'ignore' }).unref();
      } else {
        spawn('xdg-open', [deepLink], { detached: true, stdio: 'ignore' }).unref();
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, sessionId }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message || '无法打开 Pi Agent Desktop 会话' }));
    }
    return;
  }

  // 按 stored session id 打开 Hermes Desktop。直接把 hermes URI 作为启动
  // 参数传给 Electron：已运行实例由 second-instance 接收，冷启动实例由
  // main.ts 的 argv 路径接收，不依赖旧安装是否已经注册协议。
  if (pathname === '/api/open-hermes-session' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const sessionId = String(body.sessionId || '');
      const deepLink = buildHermesDesktopDeepLink(sessionId);
      if (!store.getSession(`hermes:${sessionId}`)) throw new Error('Hermes session 不存在');
      const desktopExe = resolveHermesDesktopExe();
      if (process.platform === 'win32' && fs.existsSync(desktopExe)) {
        spawn(desktopExe, [deepLink], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
        // 深链会交给已运行的单实例，但 Windows 不保证它自动切到前台。
        // 延迟激活并重试，兼容冷启动时主窗口句柄尚未创建的短暂阶段。
        setTimeout(() => focusHermesWindow(), 150);
      } else if (process.platform === 'darwin') {
        spawn('open', [deepLink], { detached: true, stdio: 'ignore' }).unref();
      } else {
        spawn('xdg-open', [deepLink], { detached: true, stdio: 'ignore' }).unref();
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, sessionId }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message || '无法打开 Hermes Desktop 会话' }));
    }
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

  // 模型端口设置：读取当前的启动命令覆盖表
  if (pathname === '/api/launch-overrides' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ overrides: launchLib.loadLaunchOverrides() }));
    return;
  }

  // 模型端口设置：保存/清除某个 agent 的启动命令覆盖
  if (pathname === '/api/launch-overrides' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const agent = String(body.agent || '');
      if (!AGENT_DEFS[agent]) throw new Error('未知 agent: ' + agent);
      const overrides = launchLib.saveLaunchOverride(agent, String(body.command || ''));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, overrides }));
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
    const agentsWithData = new Set();
    for (const id of Object.keys(AGENT_DEFS)) agentIds.add(id);
    for (const a of store.stmts.agents.all()) if (a.agent) { agentIds.add(a.agent); agentsWithData.add(a.agent); }
    for (const id of agentIds) {
      groups[id] = store.getSessions({ ...qBase, agent: id });
    }
    // defaultAgentIds：瀑布流默认视图只显示「探测为已安装」或「store 里有历史数据」的 agent 列；
    // 复用探测缓存（不额外增加真实探测开销），只影响默认视图，不影响用户手动保存过的列设置
    const probed = await getProbe();
    const defaultAgentIds = [...agentIds].filter((id) => (probed[id] && probed[id].installed) || agentsWithData.has(id));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    // liveRefs：当前实时活跃的 session ref 集合（getActive 按 10 分钟窗口），供前端渲染状态用
    res.end(JSON.stringify({
      groups, agentIds: [...agentIds], defaultAgentIds,
      liveRefs: store.getActive().map((a) => a.sessionRef),
      runtimeStatuses: store.getRuntimeStatuses(),
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
    const PROC = { claude: 'claude', codex: 'Codex', workbuddy: 'WorkBuddy' };
    const SCHEME = { claude: 'claude://', codex: 'codex://', workbuddy: 'workbuddy://' };
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
      sseBroadcast('active', { active: store.getActive(), statuses: store.getRuntimeStatuses() });
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
      sseBroadcast('active', { active: store.getActive(), statuses: store.getRuntimeStatuses() });
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

  // 手动导入（无本地数据的 agent）
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
        sseBroadcast('active', { active: store.getActive(), statuses: store.getRuntimeStatuses() });
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
      const probed = await getProbe(url.searchParams.get('force') === '1');
      const byId = Object.fromEntries(ADAPTERS.map((a) => [a.ID, a]));
      const agents = {};
      for (const [id, r] of Object.entries(probed)) {
        const meta = AGENT_DEFS[id] || {};
        // install 数据透传给前端：渲染「安装」按钮的确认弹窗要用（要跑什么命令、有什么警告）
        // picked/pickedCommand 复用 installAgent 实际执行时用的同一套 pickMethod/methodToCommand，
        // 保证确认框显示的命令和真正会跑的命令必定一致（不在前端另外拼一套）
        const def = (byId[id] && byId[id].detect) || {};
        let install = null;
        if (def.install) {
          const picked = detect.pickMethod(def.install.methods || [], process.platform);
          install = {
            ...def.install,
            picked,
            pickedCommand: picked ? detect.methodToCommand(picked, process.platform) : null,
          };
        }
        agents[id] = {
          ...r,
          name: meta.name || id, icon: meta.icon || '', color: meta.color || '#888',
          install,
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

  // 安装某个 agent（支持 tier:'cli' 和 tier:'gui'）。全局同时只允许一个安装任务在跑。
  // 响应立即返回（参考 /api/rescan 的异步模式），真实进度走 SSE 的 agent-install-progress 事件。
  if (pathname.startsWith('/api/agents/') && pathname.endsWith('/install') && req.method === 'POST') {
    const id = pathname.slice('/api/agents/'.length, -'/install'.length);
    const adapter = ADAPTERS.find((a) => a.ID === id);
    if (!adapter || !adapter.detect) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '未知 agent: ' + id }));
      return;
    }
    if (adapter.detect.tier !== 'cli' && adapter.detect.tier !== 'gui') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '这一版只支持命令行类和桌面类工具的自动安装' }));
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
          if (step === 'done') probeCache = { data: null, ts: 0 };
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
  codex.reconcileRecentCompletions(store);
  // 兼容旧版本曾把 Codex 误判为进程退出而留下的停止标记；现在 Codex 以日志为准。
  store.setAgentStopped('codex', false, Date.now());
  // 修复存量数据里的 futCache：adapter 增/改了 system context 过滤规则后，旧入库的"系统注入"
  // 消息仍占着 userMsgFlag / futCache 首位，导致 board title 取到错误内容。重启时显式按
  // 当前 extractUserQuery 重算每会话首条真实用户输入。
  store.repairUserQueries();
  // 服务停机期间已停笔的桌面会话：启动即判一次，无需等首个 20s 定时器
  try {
    workbuddy.checkDesktopIdle(store);
    deepseek.checkDesktopIdle(store);
  } catch { /* ignore */ }
  startWatchers();
  console.log('[watch] 已开始监听:', ADAPTERS.filter((a) => fs.existsSync(a.ROOT)).map((a) => a.ID).join(', '));
});
