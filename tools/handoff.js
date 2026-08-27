#!/usr/bin/env node
/**
 * agent-board-handoff — 本地侧工具（A/B 两机通用，零 token 依赖）
 *
 * 子命令:
 *   sha256 <file>                      计算文件 SHA-256
 *   manifest <projectRoot>             生成 source-manifest.json（commit/workingTreeHash/每文件 sha256/排除列表）
 *   bundle <projectRoot> <outDir>      生成 source-bundle.zip(git archive) + source-workingtree.patch(git diff, 若有未提交)
 *   state-check <stateFile>            校验状态机不倒退
 *   lease <stateFile> <deviceId> [ttl] 获取/续期任务租约（内存态，供 relay 层参考）
 *   ledger <jobId> [--mark]            本地已处理任务账本（幂等保护）
 *   validate-b <projectRoot> [--apply] B 电脑验证：检测旧 server、按 PID 精确重启、验 /api/state、
 *                                      /api/agents/status?force=1、codex --version、dsh --version、node --test，
 *                                      写 feedback/*；默认 report-only，--apply 才真正停 PID。
 *
 * 安全: 默认绝不停止任何进程；--apply 只对 CommandLine 含 server.js 且非 watchdog 的 PID 操作。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');

const EXCLUDE_DIRS = ['node_modules', 'dist', 'runtime', '.git', 'coverage', '.next-desktop', 'src-tauri'];
const EXCLUDE_FILES = ['data.json', 'package-lock.json'];
const FORBIDDEN_SUBSTR = ['.env', 'credentials', 'token', 'secret', 'id_rsa', 'data.json', 'sessions'];

function sha256File(p) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(p));
  return h.digest('hex');
}
function run(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', ...opts }).trim();
  } catch (e) {
    return null; // 命令不存在或失败都返回 null，由调用方判定
  }
}
function spawnOut(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  return { code: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}

// ---------- sha256 ----------
function cmdSha256(file) {
  console.log(sha256File(path.resolve(file)));
}

// ---------- manifest ----------
function cmdManifest(projectRoot) {
  projectRoot = path.resolve(projectRoot);
  const commit = run('git', ['rev-parse', 'HEAD'], { cwd: projectRoot }) || 'UNKNOWN';
  const status = run('git', ['status', '--porcelain'], { cwd: projectRoot }) || '';
  const workingTreeModified = status.trim().length > 0;
  // workingTreeHash: 未提交改动(diff)的 sha256；无改动则等于 commit 树哈希
  const diff = run('git', ['diff', 'HEAD'], { cwd: projectRoot }) || '';
  const workingTreeHash = crypto.createHash('sha256').update(diff || commit).digest('hex');
  const tracked = (run('git', ['ls-files'], { cwd: projectRoot }) || '').split('\n').filter(Boolean);
  const files = [];
  let skippedSensitive = [];
  for (const rel of tracked) {
    const base = path.basename(rel).toLowerCase();
    if (EXCLUDE_FILES.includes(base)) continue;
    if (FORBIDDEN_SUBSTR.some(s => rel.toLowerCase().includes(s))) { skippedSensitive.push(rel); continue; }
    const full = path.join(projectRoot, rel);
    if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) continue;
    files.push({ path: rel, size: fs.statSync(full).size, sha256: sha256File(full) });
  }
  // skill 版本：取项目内 skills 目录快照数 + package.version
  const pkgVer = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')).version || '0';
  const manifest = {
    generatedAt: new Date().toISOString(),
    sourceCommit: commit,
    workingTreeHash,
    workingTreeModified,
    skillVersion: pkgVer,
    excludedDirs: EXCLUDE_DIRS,
    excludedFiles: EXCLUDE_FILES,
    files,
    skippedSensitive,
    notes: 'node_modules/dist/runtime/data.json/session 数据已被排除；.env/token/credentials 被强制跳过。'
  };
  const out = path.join(projectRoot, 'source-manifest.json');
  fs.writeFileSync(out, JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ written: out, fileCount: files.length, skippedSensitive, workingTreeModified, commit }, null, 2));
}

// ---------- bundle ----------
function cmdBundle(projectRoot, outDir) {
  projectRoot = path.resolve(projectRoot);
  outDir = path.resolve(outDir);
  fs.mkdirSync(outDir, { recursive: true });
  const bundle = path.join(outDir, 'source-bundle.zip');
  const arch = spawnOut('git', ['archive', '--format=zip', '-o', bundle, 'HEAD'], { cwd: projectRoot });
  const result = { bundle, archiveCode: arch.code };
  const diff = run('git', ['diff', 'HEAD'], { cwd: projectRoot }) || '';
  if (diff.trim().length) {
    const patch = path.join(outDir, 'source-workingtree.patch');
    fs.writeFileSync(patch, diff);
    result.patch = patch;
    result.patchBytes = diff.length;
  } else {
    result.patch = null;
    result.note = '工作区干净，无需 patch';
  }
  console.log(JSON.stringify(result, null, 2));
}

// ---------- state machine ----------
const STATES = ['CREATED', 'SOURCE_PUBLISHED', 'B_VALIDATING', 'B_FEEDBACK_READY', 'A_PATCHING', 'PATCH_PUBLISHED', 'B_REVALIDATING', 'VERIFIED', 'BLOCKED'];
const FORWARD = {
  CREATED: ['SOURCE_PUBLISHED', 'BLOCKED'],
  SOURCE_PUBLISHED: ['B_VALIDATING', 'BLOCKED'],
  B_VALIDATING: ['B_FEEDBACK_READY', 'BLOCKED'],
  B_FEEDBACK_READY: ['A_PATCHING', 'BLOCKED'],
  A_PATCHING: ['PATCH_PUBLISHED', 'BLOCKED'],
  PATCH_PUBLISHED: ['B_REVALIDATING', 'BLOCKED'],
  B_REVALIDATING: ['VERIFIED', 'BLOCKED'],
  VERIFIED: ['BLOCKED'],
  BLOCKED: ['CREATED', 'SOURCE_PUBLISHED', 'B_VALIDATING', 'B_FEEDBACK_READY', 'A_PATCHING', 'PATCH_PUBLISHED', 'B_REVALIDATING'],
};
function cmdStateCheck(stateFile) {
  const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const cur = st.state, next = process.argv[4];
  if (!STATES.includes(cur)) return fail(`非法当前状态: ${cur}`);
  if (!STATES.includes(next)) return fail(`非法目标状态: ${next}`);
  const allowed = FORWARD[cur] || [];
  if (!allowed.includes(next)) return fail(`状态倒退/非法跳转: ${cur} -> ${next}`);
  console.log(JSON.stringify({ ok: true, from: cur, to: next }));
}
function fail(msg) { console.log(JSON.stringify({ ok: false, error: msg })); process.exit(1); }

// ---------- lease ----------
function cmdLease(stateFile, deviceId, ttl = 300) {
  const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const now = Date.now();
  const held = st.holder && st.leaseExpiresAt && st.leaseExpiresAt > now;
  if (held && st.holder !== deviceId) {
    return fail(`租约已被 ${st.holder} 持有至 ${new Date(st.leaseExpiresAt).toISOString()}`);
  }
  st.holder = deviceId;
  st.leaseExpiresAt = now + ttl * 1000;
  fs.writeFileSync(stateFile, JSON.stringify(st, null, 2));
  console.log(JSON.stringify({ ok: true, holder: deviceId, leaseExpiresAt: new Date(st.leaseExpiresAt).toISOString() }));
}

// ---------- ledger ----------
function ledgerPath() { return path.join(__dirname, '.handoff-ledger.json'); }
function cmdLedger(jobId, mark) {
  const lp = ledgerPath();
  let led = {};
  if (fs.existsSync(lp)) led = JSON.parse(fs.readFileSync(lp, 'utf8'));
  if (mark) {
    led[jobId] = { processedAt: new Date().toISOString(), device: process.env.HANDOFF_DEVICE || 'unknown' };
    fs.writeFileSync(lp, JSON.stringify(led, null, 2));
    console.log(JSON.stringify({ marked: jobId }));
  } else {
    console.log(JSON.stringify({ processed: !!led[jobId], detail: led[jobId] || null }));
  }
}

// ---------- validate-b ----------
function detectServer() {
  // 仅匹配 CommandLine 含 server.js 且非 watchdog 的 node 进程；直接在 PS 里把启动时间转成 Unix 毫秒，避免 CIM 格式解析差异
  const ps = `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*server.js*' -and $_.CommandLine -notlike '*watchdog*' } | ForEach-Object { $ep=0; try { $sp=Get-Process -Id $_.ProcessId -ErrorAction Stop; if ($sp.StartTime) { $ep=[int64]($sp.StartTime.ToUniversalTime().Subtract([datetime]'1970-01-01').TotalMilliseconds) } } catch {}; if ($ep -eq 0 -and $_.CreationDate) { try { $dt=[Management.ManagementDateTimeConverter]::ToDateTime($_.CreationDate); $ep=[int64]($dt.ToUniversalTime().Subtract([datetime]'1970-01-01').TotalMilliseconds) } catch {} }; [PSCustomObject]@{ProcessId=$_.ProcessId; CommandLine=$_.CommandLine; CreationEpoch=$ep; ExecutablePath=$_.ExecutablePath} } | ConvertTo-Json -Compress`;
  const r = spawnOut('powershell', ['-NoProfile', '-Command', ps]);
  if (r.code !== 0 || !r.stdout) return null;
  try {
    const arr = JSON.parse(r.stdout);
    const o = Array.isArray(arr) ? arr[0] : arr;
    if (!o) return null;
    const startEpoch = Number(o.CreationEpoch) || 0;
    // 从 CommandLine 推断项目根（server.js 所在目录）
    const m = (o.CommandLine || '').match(/([^\s"']+[\\\/]server\.js)/i);
    const projectRoot = m ? path.dirname(m[1]) : null;
    return {
      pid: o.ProcessId, commandLine: o.CommandLine, startEpoch,
      startTime: startEpoch ? new Date(startEpoch).toISOString() : null,
      nodeRuntime: o.ExecutablePath, projectRoot,
    };
  } catch { return null; }
}
async function httpGet(url, timeout = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const txt = await res.text();
    return { ok: res.ok, status: res.status, body: txt };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
  finally { clearTimeout(t); }
}
async function cmdValidateB(projectRoot, apply) {
  projectRoot = path.resolve(projectRoot);
  const report = { device: process.env.HANDOFF_DEVICE || 'B-VALIDATOR', startedAt: new Date().toISOString(), steps: [], warnings: [], errors: [] };
  const PORT = process.env.AB_PORT || 4876;

  // 1) 确认 projectRoot
  if (!fs.existsSync(path.join(projectRoot, 'server.js'))) {
    report.errors.push('projectRoot 缺少 server.js，拒绝继续执行');
    return finish(report, 2);
  }
  report.projectRoot = projectRoot;

  // 2) 检测 server PID / 启动时间 / 命令行 / 工作目录 / Node runtime
  const srv = detectServer();
  if (!srv) {
    report.warnings.push('未检测到运行中的 server.js 进程（可能未启动或被看门狗拉起中）');
  } else {
    report.server = srv;
    // 3) 旧 server 判定：sourceCopyTime 由调用方通过环境变量传入（源码复制到 B 的时间）
    const sourceCopyTime = process.env.SOURCE_COPY_TIME ? Number(process.env.SOURCE_COPY_TIME) : null;
    const isOld = sourceCopyTime && srv.startEpoch < sourceCopyTime;
    report.server.isOlderThanSourceCopy = !!isOld;
    if (isOld) {
      if (apply) {
        // 仅按 PID 精确停止 server.js，看门狗会自动拉起新版
        const kill = spawnOut('powershell', ['-NoProfile', '-Command', `Stop-Process -Id ${srv.pid} -Force`]);
        report.steps.push({ action: 'stop-old-server', pid: srv.pid, killCode: kill.code });
        // 等待 /api/state 回到可用（看门狗约 60-70s）
        let up = false;
        for (let i = 0; i < 40; i++) {
          await sleep(3000);
          const st = await httpGet(`http://127.0.0.1:${PORT}/api/state`);
          if (st.ok) { up = true; report.steps.push({ action: 'server-back', afterSec: (i + 1) * 3 }); break; }
        }
        if (!up) report.errors.push('旧 server 已停止但新进程未在预期时间内恢复（看门狗可能未拉起）');
      } else {
        report.steps.push({ action: 'stop-old-server', skipped: true, reason: 'report-only（未传 --apply）', pid: srv.pid });
      }
    }
  }

  // 4) 重新验证端点
  const state = await httpGet(`http://127.0.0.1:${PORT}/api/state`);
  report.checks = report.checks || {};
  report.checks.apiState = { ok: state.ok, status: state.status, bodyHead: (state.body || '').slice(0, 200) };
  const agents = await httpGet(`http://127.0.0.1:${PORT}/api/agents/status?force=1`);
  report.checks.apiAgents = { ok: agents.ok, status: agents.status };

  // 5) codex / deepseek 版本
  const codex = spawnOut('codex', ['--version']);
  const dsh = spawnOut('dsh', ['--version']);
  report.checks.codexVersion = codex.stdout || (codex.code === 0 ? '' : 'NOT_INSTALLED');
  report.checks.deepseekVersion = dsh.stdout || (dsh.code === 0 ? '' : 'NOT_INSTALLED');

  // DSH Desktop 未打补丁处理：dsh 已装但缺 Agent Board 补丁标记
  const dshPatchMarker = process.env.DSH_PATCH_MARKER || '';
  if (dsh.code === 0 && dshPatchMarker && !fs.existsSync(dshPatchMarker)) {
    report.warnings.push('DSH Desktop 已安装但未应用 Agent Board 补丁 → 标记 installed-but-unpatched，不误报服务故障、不删测试、不改 DSH 安装文件');
    report.checks.dshPatch = 'installed-but-unpatched';
  } else if (dsh.code === 0) {
    report.checks.dshPatch = 'present-or-unknown';
  }

  // 6) node --test（必须从项目根、不带路径参数）
  const test = spawnOut('node', ['--test'], { cwd: projectRoot, timeout: 240000 });
  report.checks.nodeTest = { code: test.code, stdoutTail: (test.stdout || '').split('\n').slice(-12).join('\n'), stderrTail: (test.stderr || '').slice(0, 300) };

  // 写 feedback 文件
  const fb = path.join(projectRoot, 'feedback-handoff');
  fs.mkdirSync(fb, { recursive: true });
  const diag = {
    device: report.device, generatedAt: new Date().toISOString(),
    server: report.server || null, checks: report.checks,
    warnings: report.warnings, errors: report.errors,
  };
  fs.writeFileSync(path.join(fb, 'diagnostics.json'), JSON.stringify(diag, null, 2));
  fs.writeFileSync(path.join(fb, 'test-result.json'), JSON.stringify({ code: test.code, ok: test.code === 0, passed: test.code === 0 }, null, 2));
  const ack = { device: report.device, receivedAt: new Date().toISOString(), status: report.errors.length ? 'BLOCKED' : 'RECEIVED', requiresAttention: report.errors.length > 0 };
  fs.writeFileSync(path.join(fb, 'ack.json'), JSON.stringify(ack, null, 2));
  const md = [`# B 初始化报告`, ``, `- 设备: ${report.device}`, `- 时间: ${report.startedAt}`, `- projectRoot: ${projectRoot}`, `- server: ${report.server ? report.server.pid + ' @ ' + report.server.startTime : '未检测到'}`, `- /api/state: ${report.checks.apiState.ok}`, `- /api/agents/status: ${report.checks.apiAgents.ok}`, `- codex: ${report.checks.codexVersion}`, `- deepseek(dsh): ${report.checks.deepseekVersion}`, `- node --test: exit ${test.code}`, ``, `## 警告`, ...report.warnings.map(w => `- ${w}`), ``, `## 错误`, ...report.errors.map(e => `- ${e}`)].join('\n');
  fs.writeFileSync(path.join(fb, 'initialization-report.md'), md);

  report.feedbackDir = fb;
  return finish(report, report.errors.length ? 2 : 0);
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function finish(report, code) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(code);
}

// ---------- dispatch ----------
const sub = process.argv[2];
const args = process.argv.slice(3);
try {
  switch (sub) {
    case 'sha256': return cmdSha256(args[0]);
    case 'manifest': return cmdManifest(args[0]);
    case 'bundle': return cmdBundle(args[0], args[1]);
    case 'state-check': return cmdStateCheck(args[0]);
    case 'lease': return cmdLease(args[0], args[1], Number(args[2]) || 300);
    case 'ledger': return cmdLedger(args[0], process.argv.includes('--mark'));
    case 'validate-b': return cmdValidateB(args[0], process.argv.includes('--apply'));
    default:
      console.log('usage: node handoff.js <sha256|manifest|bundle|state-check|lease|ledger|validate-b> ...');
      process.exit(1);
  }
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: String(e.stack || e) }));
  process.exit(1);
}
