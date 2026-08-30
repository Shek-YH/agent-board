'use strict';
// Agent Board 服务器：HTTP 静态 + REST + SSE 实时推送
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { exec, execFile, spawn, spawnSync } = require('child_process');
const store = require('./lib/store');
const account = require('./lib/account');
const { clearAuthCache } = require('./lib/auth-cache');
const soundSettings = require('./lib/sound-settings');
const detect = require('./lib/detect');
const launchLib = require('./lib/launch');
const { buildLaunchTargets, selectLaunchTarget, resolveLaunchRequest } = require('./lib/launch-targets');
const { buildCodexDeepLink, extractCodexThreadId } = require('./lib/codex-deep-link');
const { buildWorkBuddyDeepLink } = require('./lib/workbuddy-deep-link');
const { buildDeepSeekDesktopDeepLink } = require('./lib/deepseek-desktop-deep-link');
const { buildPiAgentDesktopDeepLink } = require('./lib/pi-agent-deep-link');
const { resolvePiAgentDesktopExe } = require('./lib/pi-agent-desktop-path');
const { resolveDeepSeekDesktopExe } = require('./lib/deepseek-desktop-path');
const { resolveFocusDll } = require('./lib/focus-dll-path');
const { buildHermesDesktopDeepLink } = require('./lib/hermes-deep-link');
const { resolveHermesDesktopExe } = require('./lib/hermes-desktop-path');
const { buildMarvisDeepLink } = require('./lib/marvis-deep-link');
const { resolveMarvisLauncher, resolveMarvisMain } = require('./lib/marvis-desktop-path');
const { resolveClaudeDesktopExe } = require('./lib/claude-desktop-path');
const { resolveClaudeSessionTarget } = require('./lib/claude-desktop-session');
const { launchClaudeDeepLink } = require('./lib/claude-desktop-launcher');
const { repairCredentialsFile } = require('./lib/dsh-credentials');
const { focusClaudeSessionWithUiAutomation, isClaudeDesktopRunning } = require('./lib/claude-desktop-uia');
const { focusZCodeSessionWithUiAutomation } = require('./lib/zcode-desktop-uia');
const { runAgentInstall, getAgentInstallDefinitions } = require('./lib/agent-installer');
const { createOrchestrationRuntime } = require('./lib/orchestrator/runtime');
const { handleOrchestrationRequest } = require('./lib/orchestrator/http');
const { buildRuntimeIdentity } = require('./lib/runtime-identity');
const { getDataDir, getConfigDir } = require('./lib/runtime-paths');
const { SOURCE_PATHS, getSourcePathsConfigPath } = require('./lib/source-paths');
const { writeRuntimeMarker, clearRuntimeMarker } = require('./lib/runtime-marker');
const { resolveWorkBuddyCliPath } = require('./lib/orchestrator/transport');
const { createJarvisVoiceRuntime } = require('./lib/jarvis-voice');
const watcher = require('./lib/watcher');
const claude = require('./lib/adapters/claude');
const codex = require('./lib/adapters/codex');
const workbuddy = require('./lib/adapters/workbuddy');
const deepseek = require('./lib/adapters/deepseek');
const marvis = require('./lib/adapters/marvis');
const zcode = require('./lib/adapters/zcode');
const pi = require('./lib/adapters/pi');
const hermes = require('./lib/adapters/hermes');
const { dispatchVerifiedMessage } = require('./lib/verified-dispatch');
const { createCodexWriter, verifyCodexDraft, verifyCodexDesktopSession } = require('./lib/codex-desktop-uia');
const { createHermesWriter, verifyHermesDraft, verifyHermesDesktopSession } = require('./lib/hermes-desktop-uia');
const { createCodexDeliveryReader } = require('./lib/codex-delivery');
const { createHermesDeliveryReader } = require('./lib/hermes-delivery');
const { createCapabilityRegistry } = require('./lib/capability-layer');
const { enrichVerifiedTarget } = require('./lib/verified-dispatch-target');
const detectionCatalog = require('./lib/agent-detection-catalog');
const AI_INSTALLABLE_IDS = new Set(Object.keys(getAgentInstallDefinitions()));

const PORT = Number(process.env.AB_PORT || 4876);
const PUBLIC = path.join(__dirname, 'public');
const HERMES_SCAN_INTERVAL_MS = 5 * 1000;
const RUNTIME_IDENTITY = buildRuntimeIdentity({
  serverRoot: __dirname,
  serverEntry: __filename,
  cwd: process.cwd(),
  nodeRuntime: process.execPath,
  nodeVersion: process.version,
  pid: process.pid,
  ppid: process.ppid,
  port: PORT,
  runtimeMode: process.env.AB_RUNTIME || 'source',
  dataDir: getDataDir(),
  configDir: getConfigDir(),
});
if (!writeRuntimeMarker(RUNTIME_IDENTITY, { dataDir: RUNTIME_IDENTITY.dataDir })) {
  console.warn('[runtime] 无法写入运行 marker，watchdog 将退化为端口探测');
}
process.on('exit', () => clearRuntimeMarker(RUNTIME_IDENTITY, { dataDir: RUNTIME_IDENTITY.dataDir }));

// ---------- Agent 可扩展配置表 ----------
// 新增 agent：加一条定义即可（proc=进程名用于激活；scheme=URL协议用于冷启动拉起；launch=备选启动命令；icon=public/icons 下的图标文件）
const AGENT_DEFS = {
  claude:    { name: 'Claude Code',      color: '#D97757', icon: 'claude.png',    proc: 'claude',    scheme: null,             launch: null },
  codex:     { name: 'Codex',            color: '#10A37F', icon: 'codex.png',     proc: 'Codex',     scheme: 'codex://',      launch: null },
  workbuddy: { name: 'WorkBuddy',        color: '#3B82F6', icon: 'workbuddy.png', proc: 'WorkBuddy', scheme: 'workbuddy://',  launch: null },
  deepseek:  { name: 'DeepSeek Harness', color: '#4D6BFE', icon: 'deepseek.png',  proc: 'DSH Desktop', scheme: 'dshdesktop://', launch: null,
    launchCmd: null },
  marvis:    { name: 'Marvis',           color: '#7C3AED', icon: 'marvis.png',    proc: 'Marvis',    scheme: null,            launch: null,
    launch: path.join(__dirname, 'marvis-launch.bat') },
  zcode:     { name: 'ZCode',            color: '#1772F0', icon: 'zcode.png',     proc: 'ZCode',     scheme: null,            launch: null,
    launch: path.join(__dirname, 'zcode-launch.bat') },
  // Pi CLI 命令叫 pi，但 Windows Desktop 的实际进程名是
  // pi-agent-desktop；前台检测必须使用后者，否则会出现“已启动但
  // windowVerified=false”，session 卡片也无法把窗口切到前台。
  pi:        { name: 'Pi Agent',         color: '#01BEBF', icon: 'pi.png',        proc: 'pi-agent-desktop', scheme: null,            launch: null },
  // Hermes CLI/安装目录叫 hermes-agent，但 Windows 桌面窗口对应的进程
  // 是 Hermes.exe；前台检测必须使用实际进程名。
  hermes:    { name: 'Hermes Agent',     color: '#F59E0B', icon: 'hermes.png',    proc: 'Hermes', scheme: 'hermes://', launch: null },
};

// 去掉配置值两端可能存在的引号（兼容旧配置写法）
function stripQuotes(s) {
  if (typeof s !== 'string') return s;
  const m = s.match(/^"(.+)"$/);
  return m ? m[1] : s;
}

function launchAgentExecutable(executable) {
  try {
    const resolved = stripQuotes(executable);
    const extension = path.extname(resolved).toLowerCase();
    const child = process.platform === 'win32' && (extension === '.cmd' || extension === '.bat')
      ? spawn('cmd.exe', ['/c', resolved], { windowsHide: true, detached: true, stdio: 'ignore', env: cleanLaunchEnv() })
      : process.platform !== 'win32' && (extension === '.sh' || extension === '.command')
        ? spawn(process.env.SHELL || '/bin/sh', [resolved], { detached: true, stdio: 'ignore', env: cleanLaunchEnv() })
      : spawn(resolved, [], { windowsHide: true, detached: true, stdio: 'ignore', env: cleanLaunchEnv() });
    // 不能让 detached 子进程的异步启动错误变成 Agent Board 未处理异常；
    // 最终是否真正打开由 launch verification 统一判断。
    child.once('error', (error) => console.warn('[launch-agent] executable start failed:', error.message));
    child.unref();
  } catch (error) {
    console.warn('[launch-agent] executable spawn failed:', error.message);
  }
}

// Agent Desktop 可能从 Electron/Node 宿主进程继承这两个变量；
// ELECTRON_RUN_AS_NODE 会让 Electron exe 直接按 Node 脚本模式退出，
// NODE_OPTIONS 也可能注入不兼容参数。所有桌面端冷启动和深链启动统一清理。
function cleanLaunchEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  return env;
}

function spawnDetachedClean(command, args = [], options = {}) {
  const child = spawn(command, args, {
    windowsHide: true,
    detached: true,
    stdio: 'ignore',
    ...options,
    env: cleanLaunchEnv(options.env || {}),
  });
  child.once('error', (error) => console.warn('[agent-launch] detached start failed:', error.message));
  child.unref();
  return child;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function execCommand(command, options = {}) {
  return new Promise((resolve, reject) => {
    exec(command, options, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || stdout || '').trim();
        reject(new Error(detail ? `${error.message}: ${detail}` : error.message));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

// focusAppCall 同时完成“窗口可见性检查”和前台激活。它可能需要编译/加载聚焦后端，
// 因此必须有超时，不能让 session API 永久等待。
function isAppWindowVisible(procName, timeoutMs = 2500) {
  if (!['win32', 'darwin'].includes(process.platform) || !procName) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    try {
      focusAppCall(procName, (result) => finish(String(result || '').startsWith('OK:')));
    } catch {
      finish(false);
    }
  });
}

async function waitForAppWindow(procName, timeoutMs = 9000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isAppWindowVisible(procName, 1200)) return true;
    await delay(250);
  }
  return false;
}

function launchGuiViaShell(executable) {
  const target = stripQuotes(executable);
  if (!target || !fs.existsSync(target)) {
    throw new Error(`未找到桌面端可执行文件：${target || '(空)'}`);
  }
  if (process.platform === 'darwin') {
    const appIndex = target.indexOf('.app/');
    const appBundle = appIndex >= 0 ? target.slice(0, appIndex + 4) : (target.endsWith('.app') ? target : '');
    spawnDetachedClean('open', [appBundle || target]);
    return;
  }
  if (process.platform !== 'win32') {
    spawnDetachedClean(target, []);
    return;
  }
  // explorer.exe 使用 Windows Shell 语义处理带空格/非系统盘的 exe，
  // 比 cmd /c start 更不容易把路径误解析成窗口标题或参数。
  spawnDetachedClean('explorer.exe', [target]);
}

// Claude Desktop 是 Windows MSIX 应用。WindowsApps 内的 claude.exe 即使
// 能被探测到，也不能稳定地交给 explorer.exe 直接打开；统一使用已注册
// 的 Deep Link 让 Windows 按 AppUserModelId 启动并复用 Claude 单实例。
function launchClaudeDesktop(cb) {
  try {
    launchClaudeDeepLink('claude://');
    cb({ ok: true, action: 'launch', agent: 'claude' });
  } catch (error) {
    cb({ ok: false, error: error.message || '启动 Claude Desktop 失败', agent: 'claude' });
  }
}

// ZCode 优先使用探测到的实际 Desktop exe；只有机器没有可执行文件时
// 才退回随包启动脚本，避免旧脚本路径或通配符失效导致顶部按钮无反应。
function launchZCodeDesktop(cb) {
  const desktopExe = resolveAgentGuiExecutable('zcode');
  const target = desktopExe || (process.platform === 'win32' ? AGENT_DEFS.zcode.launch : '');
  if (!target) {
    cb({ ok: false, error: '未找到 ZCode Desktop 启动目标', agent: 'zcode' });
    return;
  }
  launchDetachedTarget(target, (result) => cb({
    ...result,
    action: result.ok ? 'launch' : result.action,
    agent: 'zcode',
  }));
}

// ZCode 没有可验证的 session 深链。跳转时必须先把该 session 的工作区
// 投递给 ZCode，再由 UI Automation 从对应工作区的任务列表精确点击目标任务。
async function launchZCodeWorkspace(workspace) {
  const desktopExe = resolveAgentGuiExecutable('zcode');
  if (desktopExe) {
    const args = workspace ? ['--open-workspace', workspace] : [];
    await launchDetachedTargetPromise(desktopExe, args);
  } else {
    await new Promise((resolve, reject) => {
      launchZCodeDesktop((result) => result.ok ? resolve(result) : reject(new Error(result.error || '启动 ZCode Desktop 失败')));
    });
  }
  const windowVerified = ['win32', 'darwin'].includes(process.platform)
    ? await waitForAppWindow('ZCode', 9000)
    : null;
  if (windowVerified === false) throw new Error('ZCode Desktop 主窗口未确认出现');
  return { windowVerified, workspaceOpened: Boolean(workspace) };
}

function launchSchemeTargetPromise(scheme) {
  return new Promise((resolve, reject) => {
    launchSchemeTarget(scheme, (result) => result.ok ? resolve(result) : reject(new Error(result.error || '启动协议失败')));
  });
}

function launchDetachedTargetPromise(target, args = []) {
  return new Promise((resolve, reject) => {
    try {
      spawnDetachedClean(target, args);
      resolve();
    } catch (error) {
      reject(error);
    }
  });
}

async function ensureAppThenDeepLink({ procName, launchExe, sendDeepLink }) {
  // 深链本身就是桌面端的单实例启动/切换请求。不要先同步探测窗口、等待就绪再返回，
  // 否则前端 12 秒请求上限会在应用最终成功打开前先报“请求超时”。
  let launched = false;
  if (sendDeepLink) {
    await sendDeepLink();
    launched = true;
  } else if (launchExe) {
    launchGuiViaShell(launchExe);
    launched = true;
  } else {
    throw new Error('未配置桌面端启动目标');
  }
  if (procName) {
    setTimeout(() => {
      waitForAppWindow(procName, 2500)
        .then((verified) => console.log(`[launch] ${procName} window -> ${verified ? 'found' : 'pending'}`))
        .catch((error) => console.log(`[launch] ${procName} window check failed -> ${error.message}`));
    }, 0);
  }
  return { running: null, launched, windowVerified: null, verification: 'pending' };
}

function resolveAgentGuiExecutable(agent) {
  if (agent === 'claude') return resolveClaudeDesktopExe();
  if (agent === 'marvis') return resolveMarvisMain();
  if (agent === 'deepseek') return resolveDeepSeekDesktopExe();
  if (agent === 'pi') return resolvePiAgentDesktopExe();
  if (agent === 'hermes') return resolveHermesDesktopExe();
  const adapter = ADAPTERS.find((item) => item.ID === agent);
  if (!adapter) return '';
  const probed = detect.probeAgent(adapter, { userOverrides: {} }) || {};
  return probed.desktopExecutablePath || (probed.tier === 'gui' ? probed.executablePath : '') || '';
}

function buildDesktopLaunchSpecs() {
  const scheme = (id, detail) => ({
    kind: 'scheme', available: Boolean(AGENT_DEFS[id].scheme),
    value: AGENT_DEFS[id].scheme, detail,
  });
  const file = (value, detail) => ({
    kind: 'path', available: Boolean(value) && fs.existsSync(value), value, detail,
  });
  return {
    claude: file(resolveClaudeDesktopExe(), 'Claude Desktop'),
    codex: scheme('codex', 'codex:// 协议'),
    workbuddy: scheme('workbuddy', 'workbuddy:// 协议'),
    deepseek: file(resolveDeepSeekDesktopExe(), 'DeepSeek Desktop'),
    marvis: file(resolveMarvisMain(), 'Marvis.exe 主程序'),
    zcode: file(resolveAgentGuiExecutable('zcode') || (process.platform === 'win32' ? AGENT_DEFS.zcode.launch : ''), 'ZCode Desktop'),
    pi: file(resolvePiAgentDesktopExe(), 'Pi Agent Desktop'),
    hermes: file(resolveHermesDesktopExe(), 'Hermes.exe'),
  };
}

async function getAutomaticLaunchTargets() {
  return buildLaunchTargets({
    defs: AGENT_DEFS,
    probes: await getProbe(),
    desktop: buildDesktopLaunchSpecs(),
  });
}

function launchDetachedTarget(target, cb) {
  try {
    const raw = String(target || '').trim();
    if (!raw) throw new Error('启动目标为空');
    if (/^[a-z][a-z\d+.-]*:/i.test(raw) && !/^[a-z]:[\\/]/i.test(raw)) {
      throw new Error('启动目标不能是网络地址');
    }
    const resolved = stripQuotes(raw);
    const extension = path.extname(resolved).toLowerCase();
    if (process.platform !== 'win32' && ['.cmd', '.bat'].includes(extension)) {
      throw new Error('当前系统不能直接运行 Windows .cmd/.bat 启动脚本');
    }
    const direct = fs.existsSync(resolved) && !['.cmd', '.bat'].includes(extension);
    let command;
    let args;
    if (direct) {
      command = resolved;
      args = [];
    } else if (process.platform === 'win32') {
      let commandLine = raw;
      if (/^[a-z]:[\\/]/i.test(resolved) && !/[&|<>]/.test(resolved) && /\s/.test(resolved)) {
        commandLine = `"${resolved.replace(/"/g, '""')}"`;
      }
      command = 'cmd.exe';
      args = ['/c', commandLine];
    } else {
      command = process.env.SHELL || '/bin/sh';
      args = ['-lc', raw];
    }
    const child = spawn(command, args, { windowsHide: true, detached: true, stdio: 'ignore', env: cleanLaunchEnv() });
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      cb(result);
    };
    child.once('error', (error) => finish({ ok: false, error: error.message || '启动目标失败' }));
    child.unref();
    setImmediate(() => finish({ ok: true, action: 'launch-target' }));
  } catch (error) {
    cb({ ok: false, error: error.message || '启动目标失败' });
  }
}

function launchSchemeTarget(scheme, cb) {
  try {
    if (scheme.startsWith('claude://')) {
      Promise.resolve(launchClaudeDeepLink(scheme)).then(
        () => cb({ ok: true, action: 'launch-target' }),
        (error) => cb({ ok: false, error: error.message || '启动协议失败' }),
      );
      return;
    }
    if (process.platform === 'win32') {
      const child = spawn('cmd.exe', ['/d', '/s', '/c', 'start', '', scheme], { windowsHide: true, detached: true, stdio: 'ignore', env: cleanLaunchEnv() });
      let settled = false;
      child.once('error', (error) => {
        if (settled) return;
        settled = true;
        cb({ ok: false, error: error.message || '启动协议失败' });
      });
      child.unref();
      setImmediate(() => {
        if (settled) return;
        settled = true;
        cb({ ok: true, action: 'launch-target' });
      });
    } else {
      const child = spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [scheme], { detached: true, stdio: 'ignore', env: cleanLaunchEnv() });
      let settled = false;
      child.once('error', (error) => {
        if (settled) return;
        settled = true;
        cb({ ok: false, error: error.message || '启动协议失败' });
      });
      child.unref();
      setImmediate(() => {
        if (settled) return;
        settled = true;
        cb({ ok: true, action: 'launch-target' });
      });
    }
  } catch (error) {
    cb({ ok: false, error: error.message || '启动协议失败' });
  }
}

function launchAutomaticTarget(agent, requestedTarget, cb) {
  getAutomaticLaunchTargets().then((targets) => {
    const selected = selectLaunchTarget(targets, agent, requestedTarget);
    if (selected.kind === 'scheme') launchSchemeTarget(selected.value, cb);
    else if (agent === 'claude') {
      launchClaudeDesktop((result) => cb({ ...result, action: result.ok ? 'launch-target' : result.action }));
    }
    else launchDetachedTarget(selected.value, cb);
  }).catch((error) => cb({ ok: false, error: error.message || '自动启动失败' }));
}

// Hermes 顶栏启动和 session 卡片跳转共用同一条“已有窗口前台化，否则启动”链路。
// 先处理已有主窗口，避免直接带深链启动时只新增后台 helper 进程。
function launchHermesDesktop(cb) {
  const desktopExe = resolveHermesDesktopExe();
  if (process.platform === 'win32' && !fs.existsSync(desktopExe)) {
    cb({ ok: false, error: `未找到 Hermes Desktop：${desktopExe}`, agent: 'hermes' });
    return;
  }
  focusAppCall('Hermes', (result) => {
    const text = String(result || '');
    if (text.startsWith('OK:')) {
      cb({ ok: true, action: 'focus', pid: text.slice(3), agent: 'hermes' });
      return;
    }
    try {
      launchGuiViaShell(desktopExe);
      cb({ ok: true, action: 'launch', agent: 'hermes' });
    } catch (error) {
      cb({ ok: false, error: error.message || '启动 Hermes Desktop 失败', agent: 'hermes' });
    }
  });
}

async function launchHermesThenFocus() {
  const launch = await new Promise((resolve, reject) => {
    launchHermesDesktop((result) => result.ok ? resolve(result) : reject(new Error(result.error || '启动 Hermes Desktop 失败')));
  });
  const windowVerified = ['win32', 'darwin'].includes(process.platform)
    ? await waitForAppWindow('Hermes', 9000)
    : null;
  if (windowVerified === false) throw new Error('Hermes Desktop 主窗口未确认出现');
  return { ...launch, windowVerified };
}

function verifiedHermesSessionId(target) {
  const ref = String(target && target.sessionRef || '');
  return ref.startsWith('hermes:') ? ref.slice('hermes:'.length) : '';
}

// Verified Dispatch 只复用已有桌面激活入口；会话身份仍由 UIA verifier 在激活前后确认。
async function activateVerifiedSession(target) {
  if (!target || !['codex', 'hermes'].includes(target.agent)) {
    return { ok: false, code: 'UNSUPPORTED_AGENT', reason: 'Slice 0 只支持 Codex Desktop 与 Hermes Desktop' };
  }
  if (target.agent === 'codex') {
    const threadId = extractCodexThreadId(String(target.sessionRef || ''));
    if (!threadId) return { ok: false, code: 'TARGET_ANCHOR_MISSING', reason: 'Codex target 缺少 thread ID' };
    const deepLink = buildCodexDeepLink(threadId);
    const result = await launchSchemeTargetPromise(deepLink);
    return { ok: true, ...(result || {}), action: 'protocol-dispatched', deepLink, threadId };
  }

  const sessionId = verifiedHermesSessionId(target);
  if (!sessionId) return { ok: false, code: 'TARGET_ANCHOR_MISSING', reason: 'Hermes target 缺少 session ID' };
  const launch = await launchHermesThenFocus();
  const deepLink = buildHermesDesktopDeepLink(sessionId);
  const desktopExe = resolveHermesDesktopExe();
  if (process.platform === 'win32' && !fs.existsSync(desktopExe)) {
    return { ok: false, code: 'ACTIVATION_FAILED', reason: `未找到 Hermes Desktop：${desktopExe}` };
  }
  const deepLinkResult = process.platform === 'win32'
    ? await launchDetachedTargetPromise(desktopExe, [deepLink])
    : await launchSchemeTargetPromise(deepLink);
  return {
    ok: true,
    ...launch,
    ...(deepLinkResult || {}),
    action: 'launch-then-focus-then-locate',
    deepLink,
    sessionId,
  };
}

function resolveVerifiedSession(request) {
  const resolution = store.resolveSessionControlTarget({
    agent: request.agent,
    project: request.project,
    sessionRef: request.sessionRef,
  });
  if (resolution.status !== 'resolved') return resolution;
  const target = enrichVerifiedTarget(request, resolution);
  if (!target) {
    return {
      ...resolution,
      status: 'blocked',
      target: null,
      reason: '严格解析结果缺少可验证的 Agent/项目身份候选',
    };
  }
  return { ...resolution, target, candidates: [target] };
}

function createVerifiedDispatchDependencies(agent) {
  const set = AGENT_CAPABILITY_REGISTRY.get(agent);
  if (!set) return null;

  const required = [
    'sessionLocator',
    'sessionActivator',
    'identityVerifier',
    'messageWriter',
    'deliveryVerifier',
  ].map((name) => set.get(name));
  if (required.some((capability) => !capability || !capability.supported)) return null;

  const locator = set.get('sessionLocator').implementation;
  const activator = set.get('sessionActivator').implementation;
  const verifier = set.get('identityVerifier').implementation;
  const writer = set.get('messageWriter').implementation;
  const delivery = set.get('deliveryVerifier').implementation;
  return {
    resolveSession: locator,
    verifySession: verifier,
    activateSession: activator,
    captureDeliverySnapshot: (target) => delivery.snapshot(target),
    writer,
    verifyDraft: (target, message) => writer.verifyDraft(target, message),
    verifyDelivery: (target, message, context) => delivery.verify(target, message, context),
  };
}

function verifiedDispatchHttpStatus(result) {
  if (result && result.ok) return 200;
  if (result && result.status === 'reconciliation_required') return 202;
  if (result && result.status === 'blocked') return 409;
  return 400;
}

// 窗口激活：手动桌面端优先；没有指定目标时保留原有默认启动/激活逻辑。
function launchOrFocusRaw(agent, requestedTarget, cb) {
  const def = AGENT_DEFS[agent];
  if (!def) { cb({ ok: false, error: '未知 agent' }); return; }

  const manual = launchLib.loadLaunchOverrides()[agent];
  const request = resolveLaunchRequest({ manual, requested: requestedTarget || '' });
  if (request.kind === 'manual') {
    launchDetachedTarget(request.target, (result) => cb({ ...result, action: result.ok ? 'launch-override' : result.action, agent }));
    return;
  }
  if (request.target) {
    launchAutomaticTarget(agent, request.target, (result) => cb({ ...result, agent }));
    return;
  }

  // Hermes Desktop 可能尚未向 Windows 注册 hermes:// 协议；顶栏启动只需要
  // 打开应用本身，直接传可执行文件路径，避免把协议交给系统 Shell 解析。
  if (agent === 'hermes') {
    launchHermesDesktop(cb);
    return;
  }

  if (agent === 'claude') {
    launchClaudeDesktop(cb);
    return;
  }

  if (agent === 'zcode') {
    launchZCodeDesktop(cb);
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
      launchGuiViaShell(desktopExe);
      cb({ ok: true, action: 'launch', agent });
    } catch (e) {
      cb({ ok: false, error: e.message || '启动 Pi Agent Desktop 失败', agent });
    }
    return;
  }

  if (agent === 'deepseek') {
    const credentialRepair = repairCredentialsFile();
    if (credentialRepair.error) {
      cb({ ok: false, error: `DeepSeek Desktop 凭据配置错误：${credentialRepair.error}`, agent });
      return;
    }
    if (credentialRepair.repaired) console.warn(`[deepseek] 已迁移旧凭据格式，备份：${credentialRepair.backupPath}`);
    const desktopExe = resolveDeepSeekDesktopExe();
    if (process.platform === 'win32' && !fs.existsSync(desktopExe)) {
      cb({ ok: false, error: `未找到 DeepSeek Desktop：${desktopExe}` });
      return;
    }
    try {
      launchGuiViaShell(desktopExe);
      cb({ ok: true, action: 'launch', agent });
    } catch (e) {
      cb({ ok: false, error: e.message || '启动 DeepSeek Desktop 失败', agent });
    }
    return;
  }

  // launchCmd 用于浏览器/Web 类应用：直接调用外部启动脚本（含自启动+开浏览器逻辑），不再走窗口句柄激活
  if (def.launchCmd) {
    const p = stripQuotes(def.launchCmd);
    launchDetachedTarget(p, (result) => cb({ ...result, action: result.ok ? 'launch' : result.action, agent }));
    return;
  }
  // 已有协议/启动脚本的 Agent 直接交给系统处理；协议或脚本会负责单实例聚焦，
  // 顶栏接口不再先等待 PowerShell 窗口探测。
  if (def.scheme) {
    launchSchemeTarget(def.scheme, (result) => cb({ ...result, action: result.ok ? 'launch' : result.action, agent }));
    return;
  }
  if (def.launch) {
    const p = stripQuotes(def.launch);
    launchDetachedTarget(p, (result) => cb({ ...result, action: result.ok ? 'launch' : result.action, agent }));
    return;
  }
  focusAppCall(def.proc, (result) => {
    if (result.startsWith('OK')) {
      cb({ ok: true, action: 'focus', pid: result.split(':')[1] || '' });
    } else if (result === 'NOT_RUNNING') {
      const configuredExecutable = resolveAgentGuiExecutable(agent);
      if (configuredExecutable) {
        launchAgentExecutable(configuredExecutable);
      } else if (def.scheme) {
        launchSchemeTarget(def.scheme, () => {});
      } else if (def.launch) {
        const p = stripQuotes(def.launch);
        launchDetachedTarget(p, () => {});
      } else {
        cb({ ok: false, error: '未配置启动方式，请打开应用后重试' });
        return;
      }
      // 启动请求已经交给系统，窗口确认放到统一的后台验证，不阻塞 HTTP 响应。
      cb({ ok: true, action: 'launched', pid: '' });
    } else {
      cb({ ok: false, error: result });
    }
  });
}

// spawn/cmd start 返回成功只代表启动请求被交给系统，不能证明目标应用真的出现。
// 统一在启动后按 agent 的窗口进程名复核，避免前端显示“已启动”但实际没有打开。
function verifyAgentWindow(agent, cb, timeoutMs = 8000) {
  const def = AGENT_DEFS[agent];
  if (!['win32', 'darwin'].includes(process.platform)) {
    cb({ verified: null, reason: 'platform-verification-unavailable' });
    return;
  }
  if (!def || !def.proc) {
    cb({ verified: false, reason: 'process-name-unavailable' });
    return;
  }
  let settled = false;
  const startedAt = Date.now();
  const finish = (result) => {
    if (settled) return;
    settled = true;
    clearTimeout(deadlineTimer);
    cb(result);
  };
  const deadlineTimer = setTimeout(() => finish({ verified: false, reason: 'verification-timeout' }), timeoutMs);
  const check = () => {
    if (settled) return;
    focusAppCall(def.proc, (result) => {
      const text = String(result || '');
      if (text.startsWith('OK:')) {
        finish({ verified: true, pid: text.slice(3), reason: 'window-found' });
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        finish({ verified: false, reason: text === 'NOT_RUNNING' ? 'process-not-running' : (text || 'focus-check-failed') });
        return;
      }
      setTimeout(check, 250);
    });
  };
  check();
}

function buildLaunchRecovery(agent, requestedTarget) {
  const def = AGENT_DEFS[agent] || {};
  const adapter = ADAPTERS.find((item) => item.ID === agent);
  let probe = {};
  if (adapter) {
    try { probe = detect.probeAgent(adapter, { userOverrides: {} }) || {}; } catch (error) {
      probe = { probeError: error.message || '探测失败' };
    }
  }
  let desktop = {};
  try { desktop = buildDesktopLaunchSpecs()[agent] || {}; } catch { desktop = {}; }
  const detectedPath = [probe.executablePath, probe.desktopExecutablePath]
    .find((candidate) => typeof candidate === 'string' && fs.existsSync(candidate)) || null;
  const suggestions = [];
  if (detectedPath) {
    const variantLabel = probe.desktopExecutablePath === detectedPath && !probe.executablePath ? 'Desktop' : 'CLI';
    suggestions.push(`已找到真实 ${variantLabel} 可执行文件：${detectedPath}`);
    suggestions.push('打开“应用管理”，点击该 Agent 的“自动配置路径”，然后重新点击启动。');
  } else if (probe.installed !== true && desktop.available !== true) {
    suggestions.push('未找到可用的 CLI 或桌面端，请先安装对应 Agent，或确认安装路径。');
  }
  if (probe.tier === 'cli' && requestedTarget !== 'cli') {
    suggestions.push('当前只识别到 CLI 变体；CLI 可能需要在终端中带参数启动，若需要窗口请安装对应 Desktop 版本。');
  }
  if (requestedTarget === 'desktop' && desktop.available !== true) {
    suggestions.push('当前没有可用的桌面端启动目标，请在“应用管理”确认 Desktop 是否安装。');
  }
  if (!suggestions.length) suggestions.push('请打开“应用管理”重新探测，并确认 Agent 的真实安装路径。');
  return {
    status: detectedPath || desktop.available ? 'target-found-but-not-verified' : 'target-not-found',
    detectedPath,
    detectedTier: probe.tier || null,
    detectedVersion: probe.version || probe.registryName || null,
    detectedSource: probe.source || null,
    desktopTarget: desktop.available ? { detail: desktop.detail || '', value: desktop.value || '' } : null,
    autoConfigureAvailable: Boolean(detectedPath),
    suggestions,
  };
}

function finalizeLaunchResult(agent, requestedTarget, result, cb) {
  if (!result || result.ok !== true) {
    cb({ ...(result || { ok: false }), verified: false, recovery: buildLaunchRecovery(agent, requestedTarget) });
    return;
  }
  // 已经由 focusAppCall 确认过的窗口不需要再次等待；其他路径先返回投递结果，
  // 再异步复核窗口，避免桌面端冷启动拖过前端请求超时。
  if (result.action === 'focus') {
    cb({ ...result, verified: true, verification: 'window-found' });
    return;
  }
  cb({ ...result, verified: null, verification: 'pending' });
  setTimeout(() => verifyAgentWindow(agent, (verification) => {
    if (verification.verified === true) {
      console.log(`[launch-agent] ${agent} window verified -> ${verification.pid || '?'}`);
      return;
    }
    const recovery = buildLaunchRecovery(agent, requestedTarget);
    console.warn(`[launch-agent] ${agent} background verification failed`, JSON.stringify({
      ...result,
      ok: false,
      code: 'launch-not-verified',
      error: '启动请求已发送，但未确认目标应用窗口或进程已打开',
      ...verification,
      recovery,
    }));
  }), 0);
}

function launchOrFocus(agent, requestedTarget, cb) {
  launchOrFocusRaw(agent, requestedTarget, (result) => finalizeLaunchResult(agent, requestedTarget, result, cb));
}

// ---------- 窗口激活：预编译 Win32 DLL（避免每次点跳转都重新编译 C#） ----------
const FOCUS_DLL = resolveFocusDll({ backendDir: __dirname });
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
  const escapePsSingleQuoted = (value) => value.replace(/'/g, "''");
  const focusDir = escapePsSingleQuoted(path.dirname(FOCUS_DLL));
  const focusDll = escapePsSingleQuoted(FOCUS_DLL);
  const ps = `$dir = '${focusDir}'; if (-not (Test-Path $dir)) { New-Item -ItemType Directory $dir | Out-Null }; Add-Type -TypeDefinition @"
${FOCUS_CS}
"@ -OutputAssembly '${focusDll}'`;
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
    `$ErrorActionPreference='SilentlyContinue'; Add-Type -Path '${FOCUS_DLL.replace(/'/g, "''")}'`,
    `function Focus($n){$p=Get-Process -Name $n -ErrorAction SilentlyContinue|Where-Object{$_.MainWindowHandle -ne 0}|Sort-Object StartTime -Descending|Select-Object -First 1;if(-not $p){Write-Output 'DONE:NOT_RUNNING';return};$h=$p.MainWindowHandle;if([WF]::IsIconic($h)){[WF]::ShowWindow($h,9)|Out-Null};[WF]::keybd_event(0x12,0,0,[UIntPtr]::Zero);[WF]::keybd_event(0x12,0,2,[UIntPtr]::Zero);[WF]::SetForegroundWindow($h)|Out-Null;[WF]::BringWindowToTop($h)|Out-Null;Start-Sleep -Milliseconds 80;[WF]::SetForegroundWindow($h)|Out-Null;Write-Output ('DONE:OK:'+$p.Id)}`,
    `Write-Output 'READY'`,
  ].join('\r\n') + '\r\n');
}
function focusAppCall(procName, cb) {
  if (process.platform === 'darwin') {
    const name = String(procName || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const script = [
      'tell application "System Events"',
      `tell process "${name}"`,
      'if (count of windows) > 0 then',
      'set frontmost to true',
      'return "OK"',
      'else',
      'return "NOT_RUNNING"',
      'end if',
      'end tell',
      'end tell',
    ].join('\n');
    execFile('osascript', ['-e', script], { encoding: 'utf8', timeout: 3000 }, (error, stdout) => {
      if (error) { cb('NOT_RUNNING'); return; }
      cb(String(stdout || '').trim() === 'OK' ? 'OK:mac' : 'NOT_RUNNING');
    });
    return;
  }
  if (process.platform !== 'win32') {
    cb('UNSUPPORTED');
    return;
  }
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
function focusWorkBuddyWindow(attempt = 0) {
  focusAppCall('WorkBuddy', (result) => {
    if (result === 'NOT_RUNNING' && attempt < 12) {
      setTimeout(() => focusWorkBuddyWindow(attempt + 1), 150);
      return;
    }
    console.log(`[open-workbuddy-session] focus WorkBuddy -> ${result || '?'}`);
  });
}
const ADAPTERS = [claude, codex, workbuddy, deepseek, marvis, zcode, pi, hermes];

function unsupportedCapability(reason) {
  return {
    supported: false,
    implementation: null,
    source: 'unavailable',
    reason,
  };
}

function readerCapability(adapter) {
  const supported = typeof adapter.scanAll === 'function' && typeof adapter.poll === 'function';
  return supported
    ? { supported: true, implementation: adapter, source: 'adapter' }
    : unsupportedCapability('Adapter 没有完整的 scanAll/poll Conversation Reader');
}

function completionCapability(adapter) {
  const methods = [
    'parseLines',
    'parseSessionRows',
    'parseSessionStatus',
    'checkDesktopIdle',
    'isDeepSeekIdleComplete',
    'scanHeartbeats',
    'scanSessionStatuses',
  ].filter((name) => typeof adapter[name] === 'function');
  return methods.length
    ? { supported: true, implementation: adapter, source: 'adapter', methods }
    : unsupportedCapability('Adapter 尚未暴露独立的 Completion Detector 入口');
}

const VERIFIED_CAPABILITY_BINDINGS = {
  codex() {
    const writer = createCodexWriter();
    const delivery = createCodexDeliveryReader();
    return {
      sessionActivator: { supported: true, implementation: activateVerifiedSession, source: 'deep-link' },
      identityVerifier: { supported: true, implementation: verifyCodexDesktopSession, source: 'uia' },
      messageWriter: {
        supported: true,
        implementation: {
          write: writer.write,
          send: writer.send,
          verifyDraft: verifyCodexDraft,
        },
        source: 'uia',
      },
      deliveryVerifier: { supported: true, implementation: delivery, source: 'delivery-reader' },
    };
  },
  hermes() {
    const writer = createHermesWriter();
    const delivery = createHermesDeliveryReader();
    return {
      sessionActivator: { supported: true, implementation: activateVerifiedSession, source: 'deep-link' },
      identityVerifier: { supported: true, implementation: verifyHermesDesktopSession, source: 'uia' },
      messageWriter: {
        supported: true,
        implementation: {
          write: writer.write,
          send: writer.send,
          verifyDraft: verifyHermesDraft,
        },
        source: 'uia',
      },
      deliveryVerifier: { supported: true, implementation: delivery, source: 'delivery-reader' },
    };
  },
};

function capabilityDefinitionsForAdapter(adapter) {
  const unsupported = unsupportedCapability('Slice 1 尚未为 ' + adapter.ID + ' 接入该能力');
  const definitions = {
    sessionLocator: { supported: true, implementation: resolveVerifiedSession, source: 'core' },
    sessionActivator: unsupported,
    conversationReader: readerCapability(adapter),
    identityVerifier: unsupported,
    messageWriter: unsupported,
    deliveryVerifier: unsupported,
    completionDetector: completionCapability(adapter),
  };
  const bindingFactory = VERIFIED_CAPABILITY_BINDINGS[adapter.ID];
  return bindingFactory ? { ...definitions, ...bindingFactory() } : definitions;
}

const AGENT_CAPABILITY_REGISTRY = createCapabilityRegistry(
  ADAPTERS.map((adapter) => ({
    agentId: adapter.ID,
    capabilities: capabilityDefinitionsForAdapter(adapter),
  })),
);

// 只探测条目不参与 scanAll / fs.watch；它们仅用于应用管理，后续补齐正式 adapter
// 后从这个目录迁入即可。
const PROBE_ONLY_ADAPTERS = detectionCatalog;
const PROBE_ADAPTERS = [...ADAPTERS, ...PROBE_ONLY_ADAPTERS];
store.migrateCodexCompletionSignals();
const collectorHealth = new Map(ADAPTERS.map((adapter) => [adapter.ID, {
  root: adapter.ROOT,
  rootExists: fs.existsSync(adapter.ROOT),
  lastScanAt: null,
  lastScanMode: null,
  lastScanFiles: 0,
  lastEventAt: null,
  lastMessageCount: 0,
  lastError: null,
}]));

function updateCollectorHealth(agent, patch) {
  const previous = collectorHealth.get(agent) || {};
  collectorHealth.set(agent, { ...previous, ...patch });
}

function getCollectorHealth() {
  return Object.fromEntries([...collectorHealth.entries()].map(([agent, value]) => [agent, {
    ...value,
    rootExists: fs.existsSync(value.root),
  }]));
}

function fileMetaKey(kind, adapter, filePath) {
  return `${kind}:${adapter.ID}:${filePath}`;
}

function fileOffsetKey(adapter, filePath) {
  return typeof adapter.fileOffsetKey === 'function'
    ? adapter.fileOffsetKey(filePath)
    : `offset:${adapter.ID}:${filePath}`;
}

function prepareFileOffset(adapter, filePath) {
  const current = watcher.fileSignature(filePath);
  if (!current) return null;
  const previousIdentity = store.stmts.getMeta.get(fileMetaKey('file-id', adapter, filePath))?.v || '';
  const previousSizeValue = store.stmts.getMeta.get(fileMetaKey('file-size', adapter, filePath))?.v;
  const previous = previousIdentity || previousSizeValue !== undefined
    ? { identity: previousIdentity, size: Number(previousSizeValue || 0) }
    : null;
  if (watcher.shouldResetOffset(previous, current)) {
    store.stmts.setMeta.run(fileOffsetKey(adapter, filePath), '0');
  }
  return current;
}

function rememberFileOffset(adapter, filePath, signature) {
  if (!signature) return;
  store.stmts.setMeta.run(fileMetaKey('file-id', adapter, filePath), signature.identity);
  store.stmts.setMeta.run(fileMetaKey('file-size', adapter, filePath), String(signature.size));
}

// 探测结果缓存：5 分钟 TTL。避免 /api/board（首页高频调用）每次都触发一次完整探测
// （registry 查询 + 逐个 agent spawnSync 查版本号）。安装成功时主动失效，不等 TTL。
const PROBE_CACHE_TTL_MS = 5 * 60 * 1000;
let probeCache = { data: null, ts: 0 };
let probeInFlight = null;
async function getProbe(force = false) {
  if (!force && probeCache.data && Date.now() - probeCache.ts < PROBE_CACHE_TTL_MS) {
    return probeCache.data;
  }
  // 多个页面/按钮同时请求时共用一次探测，避免重复调用 reg.exe、where.exe 和版本命令。
  if (probeInFlight) return probeInFlight;
  probeInFlight = detect.probeAll(PROBE_ADAPTERS)
    .then((data) => {
      probeCache = { data, ts: Date.now() };
      return data;
    })
    .finally(() => { probeInFlight = null; });
  return probeInFlight;
}

// ---------- SSE 客户端管理 ----------
const sseClients = new Set();
function sseBroadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch { sseClients.delete(res); }
  }
}

// 人工监控和 AI 监控共用这一个工作流状态源；AI 面板只负责展示/发起编排请求，
// 不再另起一套会话缓存。默认不允许 headless Agent 执行，需显式配置环境变量开启。
const orchestration = createOrchestrationRuntime({
  workbuddyCliPath: resolveWorkBuddyCliPath({ desktopExecutable: resolveAgentGuiExecutable('workbuddy') }),
  onWorkflowChange: (workflow) => sseBroadcast('orchestration', { workflow }),
});
const jarvisVoice = createJarvisVoiceRuntime({ orchestration, env: process.env });
orchestration.jarvisVoice = jarvisVoice;

// ---------- 采集调度 ----------
let isScanning = false;
const SCAN_DAYS = 30;          // 首次只扫近 30 天，老文件由增量/rescan 补齐
const BIG_FILE = 2 * 1024 * 1024;   // 大于 2MB 的文件只取末尾（最近消息）
async function scanAll({ full = false } = {}) {
  if (isScanning) return;
  isScanning = true;
  const cutoff = full ? 0 : Date.now() - SCAN_DAYS * 24 * 3600 * 1000;
  const jobs = [];
  const scanCounts = new Map(ADAPTERS.map((adapter) => [adapter.ID, 0]));
  for (const a of ADAPTERS) {
    updateCollectorHealth(a.ID, { rootExists: fs.existsSync(a.ROOT), lastError: null });
    if (!fs.existsSync(a.ROOT)) continue;
    for (const f of watcher.collectFiles(a.ROOT, a.isSessionFile)) {
      const mtime = watcher.fileMtime(f);
      if (!full && mtime < cutoff) continue; // 老文件跳过，等增量或手动 rescan
      jobs.push({ adapter: a, file: f });
      scanCounts.set(a.ID, scanCounts.get(a.ID) + 1);
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
        const key = fileOffsetKey(j.adapter, j.file);
        const signature = prepareFileOffset(j.adapter, j.file);
        const offset = full ? 0 : Number(store.stmts.getMeta.get(key)?.v || 0);
        const size = watcher.fileSize(j.file);
        let lines = [], newOffset = offset;
        if (j.adapter.readFile) {
          // 自定义读取（如 zstd 压缩文件），offset 语义由 adapter 自行解释（通常是行号）
          const t = j.adapter.readFile(j.file, offset);
          lines = t.lines; newOffset = t.newOffset;
        } else if (!full && offset >= size) {
          // Codex 旧版已经消费完日志时仍要读取首条 session_meta，
          // 让存量记录获得新的父子拓扑，不必清空 offset 或重扫全文。
          if (j.adapter.ID === 'codex') {
            const metaLine = codex.readSessionMetaLine(j.file);
            if (metaLine) {
              const metaMsgs = j.adapter.parseLines([metaLine], j.file);
              for (const m of metaMsgs) { store.ingest(m); total++; }
            }
          }
          continue; // 已消费完
        } else if (full || size > BIG_FILE) {
          // 全量重扫和大文件都必须从 0 读完；消息按 source_id 幂等覆盖，不会重复。
          // 普通增量才使用 offset，否则 旧 offset 可能让历史永久漏掉。
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
        rememberFileOffset(j.adapter, j.file, signature);
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
        updateCollectorHealth(a.ID, { lastScanAt: new Date().toISOString(), lastScanMode: full ? 'full' : 'recent', lastMessageCount: c, lastError: null });
      } catch (e) {
        updateCollectorHealth(a.ID, { lastScanAt: new Date().toISOString(), lastError: e.message });
        console.error(`[${a.ID}] scanAll failed:`, e.message);
      }
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
  for (const a of ADAPTERS) {
    updateCollectorHealth(a.ID, {
      lastScanAt: new Date().toISOString(),
      lastScanMode: full ? 'full' : 'recent',
      lastScanFiles: scanCounts.get(a.ID) || 0,
    });
  }
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
      store.stmts.setMeta.run(fileOffsetKey(adapter, p), '0');
    }
  }
  try {
    if (live.length) {
      const signatures = new Map(live.map((filePath) => [filePath, prepareFileOffset(adapter, filePath)]));
      const n = store.tx(() => adapter.poll(store, live));
      for (const [filePath, signature] of signatures) rememberFileOffset(adapter, filePath, signature || watcher.fileSignature(filePath));
      updateCollectorHealth(adapter.ID, {
        lastEventAt: new Date().toISOString(), lastMessageCount: n, lastError: null,
      });
      if (n > 0) {
        console.log(`[${adapter.ID}] +${n} 条`);
        sseBroadcast('message', { agent: adapter.ID, count: n });
      }
    }
  } catch (e) {
    updateCollectorHealth(adapter.ID, { lastEventAt: new Date().toISOString(), lastError: e.message });
    console.error(`[${adapter.ID}] 增量解析失败:`, e.message);
  }
  if (deleted.length) {
    console.log(`[${adapter.ID}] 源文件删除，移除 ${deleted.length} 个会话`);
    sseBroadcast('hide', { sessions: deleted });
  }
}

function startWatchers() {
  const stops = [];
  const snapshots = new Map();
  for (const a of ADAPTERS) {
    // Hermes 的数据源是 state.db，根目录下还包含十万级缓存文件；它已有
    // 专用 SQLite 兜底轮询，不能对整个根目录做递归快照/监听。
    if (a.ID === 'hermes') continue;
    snapshots.set(a.ID, watcher.snapshotTree(a.ROOT, () => true));
    stops.push(watcher.watchTree(a.ROOT, (p) => pollChanged(a, [p])));
  }
  // fs.watch 是低延迟加速器，定时快照是跨 Windows/macOS 文件系统、目录晚创建、
  // WAL/原子替换和偶发丢事件时的正确性兜底。这里不要求 ROOT 在启动时已经存在。
  const reconcileTimer = setInterval(() => {
    if (isScanning) return;
    for (const a of ADAPTERS) {
      if (a.ID === 'hermes') continue;
      const previous = snapshots.get(a.ID) || {};
      const current = watcher.snapshotTree(a.ROOT, () => true);
      const diff = watcher.diffSnapshots(previous, current);
      snapshots.set(a.ID, current);
      const changed = [...diff.changed, ...diff.deleted];
      if (changed.length) pollChanged(a, changed);
    }
  }, 10 * 1000);
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
    if (isScanning) return;
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
    if (isScanning) return;
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
    if (isScanning) return;
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
  return () => { for (const s of stops) s(); clearInterval(reconcileTimer); clearInterval(hbTimer); clearInterval(codexTitleTimer); clearInterval(dsTimer); clearInterval(zcTimer); clearInterval(hermesTimer); clearInterval(deskTimer); clearInterval(procTimer); };
}

// CLI agent 进程名 → 进程检查。仅收录已实测确认的进程名；匹配不到进程
// = 该 agent 全部 session 提前 done。Windows/macOS 的进程查询格式不同，
// 不能在 macOS 继续调用 tasklist。
const PROC_PATTERNS = process.platform === 'darwin'
  ? {
      claude: ['claude'],
      zcode: ['zcode'],
    }
  : {
      claude: ['claude.exe'],
      // Codex Desktop 的实际宿主进程不稳定（当前版本不一定叫 codex.exe），
      // 不能用进程名缺失强制结束会话；Codex 以 JSONL 日志和 task_complete 判定为准。
      zcode: ['zcode.exe'],
    };
function checkAgentProcesses() {
  let text;
  try {
    const command = process.platform === 'win32' ? 'tasklist' : 'ps';
    const args = process.platform === 'win32' ? ['/FO', 'CSV', '/NH'] : ['-axo', 'command='];
    const r = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 15000 });
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
  '.skill': 'application/zip',
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
    if (err) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not Found' }));
      return;
    }
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

  if (pathname === '/api/jarvis/readiness' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(jarvisVoice.readiness()));
    return;
  }

  if (pathname === '/api/jarvis/voice' && req.method === 'POST') {
    try {
      const body = await readAudioBody(req);
      const result = await jarvisVoice.handleVoice(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (error) {
      const status = Number(error.statusCode) || 400;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message || 'Jarvis 语音任务失败' }));
    }
    return;
  }

  if (pathname.startsWith('/api/jarvis/audio/') && req.method === 'GET') {
    let fileName = '';
    try { fileName = decodeURIComponent(pathname.slice('/api/jarvis/audio/'.length)); } catch { fileName = ''; }
    const audio = jarvisVoice.readAudio(fileName);
    if (!audio) { res.writeHead(404); res.end('Not Found'); return; }
    res.writeHead(200, { 'Content-Type': 'audio/wav', 'Cache-Control': 'private, max-age=3600' });
    res.end(audio);
    return;
  }

  // Jarvis / AI 监控 / CLI 共用的编排 API。
  if (pathname.startsWith('/api/orchestration/')) {
    try {
      const body = req.method === 'POST' ? await readBody(req) : {};
      const result = await handleOrchestrationRequest({
        method: req.method, pathname, query: url.searchParams, body, runtime: orchestration,
      });
      if (!result) { res.writeHead(404); res.end(JSON.stringify({ error: 'orchestration endpoint not found' })); return; }
      const background = result.background;
      res.writeHead(result.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result.body));
      if (background) background.catch((error) => console.error('[orchestration] background failed:', error.message));
    } catch (error) {
      const status = Number(error.statusCode) || 400;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message || 'orchestration request failed' }));
    }
    return;
  }

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

  // 运行/采集诊断：只返回身份、路径摘要和计数，不返回任何会话正文。
  if (pathname === '/api/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      scanning: isScanning,
      runtime: RUNTIME_IDENTITY,
      sourcePathsConfig: getSourcePathsConfigPath(),
      sourcePaths: SOURCE_PATHS,
      collectors: getCollectorHealth(),
      sseClients: sseClients.size,
      checkedAt: new Date().toISOString(),
    }));
    return;
  }

  if (pathname === '/api/capabilities' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ items: AGENT_CAPABILITY_REGISTRY.report() }));
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
    res.end(JSON.stringify({ runtime: RUNTIME_IDENTITY, stats, agents, projects, active, agentsDef: AGENT_DEFS }));
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

  if (pathname === '/api/sounds/enabled' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      if (!Array.isArray(body.agents) || !body.agents.length || !body.agents.every((agent) => typeof agent === 'string' && Object.hasOwn(AGENT_DEFS, agent))) {
        throw new TypeError('Invalid agents');
      }
      if (typeof body.enabled !== 'boolean') throw new TypeError('Invalid sound enabled state');
      const enabled = body.enabled;
      const role = body.role === undefined ? 'all' : body.role;
      if (role !== 'all' && role !== 'main' && role !== 'child') throw new TypeError('Invalid sound role');
      const agents = [...new Set(body.agents)];
      const settings = soundSettings.setSoundsEnabled(agents, enabled, undefined, role);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(settings));
    } catch (error) {
      const badInput = error instanceof TypeError || error instanceof RangeError || error instanceof SyntaxError || error.statusCode === 413;
      res.writeHead(error.statusCode === 413 ? 413 : (badInput ? 400 : 500), { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.statusCode === 413 ? 'Audio upload is too large' : (badInput ? 'Invalid sound enabled state' : 'Unable to save sound enabled state') }));
    }
    return;
  }

  // Slice 0 Verified Dispatch：只接受明确的 agent/project/sessionRef/message，
  // 所有身份、UIA、快照和送达证据均由 fail-closed 编排器串联。
  if (pathname === '/api/verified-dispatch' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const request = {
        agent: String(body && body.agent || '').trim().toLowerCase(),
        project: String(body && body.project || '').trim(),
        sessionRef: String(body && body.sessionRef || '').trim(),
        message: String(body && body.message == null ? '' : body && body.message || ''),
      };
      if (!request.agent || (!request.sessionRef && !request.project) || !request.message.trim()) {
        const error = new Error('verified dispatch 需要 agent、sessionRef/project 至少一个和非空 message');
        error.statusCode = 400;
        throw error;
      }
      const dependencies = createVerifiedDispatchDependencies(request.agent);
      if (!dependencies) {
        const error = new Error('Slice 0 只支持 Codex Desktop 与 Hermes Desktop');
        error.statusCode = 400;
        throw error;
      }
      const result = await dispatchVerifiedMessage(request, dependencies);
      res.writeHead(verifiedDispatchHttpStatus(result), { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (e) {
      const status = e.statusCode === 400 ? 400 : 500;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: false,
        status: 'failed',
        phase: 'PREPARE',
        failure: { code: status === 400 ? 'INVALID_REQUEST' : 'DISPATCH_ROUTE_FAILED', reason: e.message || 'verified dispatch failed' },
        reconciliationRequired: false,
      }));
    }
    return;
  }

  // 按 threadId 打开指定 Codex 会话。只接受固定格式的 ID，不接受任意 URL。
  if (pathname === '/api/open-codex-thread' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const threadId = body && body.threadId;
      const deepLink = buildCodexDeepLink(threadId);
      // Codex 的 Windows Store/Electron 架构没有稳定可用的独立主窗口进程名：
      // 不能用 guessed procName 阻塞 11 秒后再判定失败。协议本身会把目标
      // thread 交给 Codex 单实例，接口只报告“已投递”，由系统负责拉起/切换。
      await launchSchemeTargetPromise(deepLink);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, threadId, action: 'protocol-dispatched', windowVerified: null }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message || '无法打开 Codex 会话' }));
    }
    return;
  }

  // WorkBuddy 桌面端原生支持 workbuddy://chat/<conversationId> 深链。
  // Windows 的协议处理由 WorkBuddy 单实例主进程接收：已有实例走
  // second-instance，未运行时走初始 argv，不会创建第二个可见主窗口。
  if (pathname === '/api/open-workbuddy-session' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const sessionId = String(body.sessionId || '');
      const deepLink = buildWorkBuddyDeepLink(sessionId);
      if (!store.getSession(`workbuddy:${sessionId}`)) throw new Error('WorkBuddy session 不存在');
      const result = await ensureAppThenDeepLink({
        procName: AGENT_DEFS.workbuddy.proc,
        launchExe: resolveAgentGuiExecutable('workbuddy'),
        sendDeepLink: () => launchSchemeTargetPromise(deepLink),
      });
      const ok = result.windowVerified !== false;
      res.writeHead(ok ? 200 : 502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok, sessionId, deepLink, ...result, ...(ok ? {} : { error: 'WorkBuddy 主窗口未确认出现，深链未能可靠跳转' }) }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message || '无法打开 WorkBuddy 会话' }));
    }
    return;
  }

  // Marvis 桌面端通过 marvis://conversation/share?id=<conversation_id>
  // 伪协议命令打开已有会话。该命令由 Marvis 内部导航到 /chat/<id>。
  // 直接调用已注册的 MarvisLauncher.exe：已有实例由 Marvis 的 pseudo protocol
  // 单实例通道接收，未运行时由启动器创建唯一主实例，避免 cmd start 再开第二个窗口。
  if (pathname === '/api/open-marvis-session' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const sessionId = String(body.sessionId || '');
      const deepLink = buildMarvisDeepLink(sessionId);
      if (!store.getSession(`marvis:${sessionId}`)) throw new Error('Marvis session 不存在');
      const launcher = resolveMarvisLauncher();
      const mainExe = resolveMarvisMain();
      if (!launcher || !fs.existsSync(launcher)) throw new Error('未找到 MarvisLauncher.exe');
      if (!mainExe || !fs.existsSync(mainExe)) throw new Error('未找到 Marvis.exe 主程序');
      const result = await ensureAppThenDeepLink({
        procName: AGENT_DEFS.marvis.proc,
        launchExe: mainExe,
        sendDeepLink: () => launchDetachedTargetPromise(launcher, [deepLink]),
      });
      const ok = result.windowVerified !== false;
      res.writeHead(ok ? 200 : 502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok, sessionId, deepLink, ...result, ...(ok ? {} : { error: 'Marvis 主窗口未确认出现，深链未能可靠跳转' }) }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message || '无法打开 Marvis 会话' }));
    }
    return;
  }

  // 按 Claude Code session 精确打开 Claude Desktop。CLI-only/已导入会话走
  // resume；Desktop-native 会话走 desktopSessionId 的 focus 深链，绝不退回
  // resume(cliSessionId)，避免把原生会话复制成 transcript snapshot。
  if (pathname === '/api/open-claude-session' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const sessionId = String(body.sessionId || '');
      const session = store.getSession(`claude:${sessionId}`);
      if (!session) throw new Error('Claude session 不存在');
      const target = resolveClaudeSessionTarget({ cliSessionId: sessionId, cwd: session.project });
      if (target.status === 'ambiguous') {
        throw new Error('Claude Desktop 存在多个匹配会话，请先按项目路径区分');
      }
      // Imported CLI descriptor 通常没有 title；UIA 仍需要用看板里的会话标题
      // 找到 Desktop sidebar 卡片。只补充内存中的定位信息，不修改 Claude 文件。
      target.title ||= session.title;
      // Desktop-native 会话已经存在于 Claude Desktop 时，只做无副作用的进程探测，
      // 不再先调用通用前台激活器。前台切换统一交给 UIA 精确定位目标 session，
      // 避免通用 Focus + UIA 双重抢前台导致用户切换到其它程序后又被抢回 Claude。
      const claudeWindowRunning = process.platform === 'win32' && isClaudeDesktopRunning();
      const claudeAlreadyRunning = target.origin === 'desktop' && claudeWindowRunning;
      if (!claudeAlreadyRunning) {
        // Claude Desktop 是 MSIX，冷启动统一交给 Deep Link，避免直接
        // 打开受保护的 WindowsApps\\...\\claude.exe 触发系统路径错误。
        await launchClaudeDeepLink(target.deepLink);
      }
      if (target.desktopSessionId && process.platform === 'win32') {
        // UIA 只激活并选择目标 session 一次。冷启动要等 Desktop 窗口出现，
        // 已运行实例则立即执行；Desktop-native 失败时绝不改用 resume。
        if (target.origin === 'desktop') {
          setTimeout(() => {
            focusClaudeSessionWithUiAutomation(target).then((result) => {
              console.log(`[open-claude-session] UIA fallback -> ${result.status}`);
            }).catch((error) => {
              console.log(`[open-claude-session] UIA fallback failed -> ${error.message}`);
            });
          }, 0);
        } else {
          // 导入的 CLI session 仍然先打开 Claude Desktop 的 resume 深链，
          // 再异步用 UIA 定位对应 Code 卡片。session 按钮不能自动改开 CLI；
          // CLI 恢复只允许用户从“更多”菜单显式选择。
          setTimeout(() => {
            focusClaudeSessionWithUiAutomation(target).then((result) => {
              console.log(`[open-claude-session] UIA fallback -> ${result.status}`);
            }).catch((error) => {
              console.log(`[open-claude-session] UIA fallback failed -> ${error.message}`);
            });
          }, 900);
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        sessionId,
        origin: target.origin,
        action: target.action,
        desktopSessionId: target.desktopSessionId,
      }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message || '无法打开 Claude Desktop 会话' }));
    }
    return;
  }

  // ZCode 没有 session 深链：先投递 session 对应工作区并确认主窗口，再按
  // session ID/标题定位唯一任务；找不到任务时结束本次脚本，不跳转其它 session。
  if (pathname === '/api/open-zcode-session' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const sessionId = String(body.sessionId || '');
      const session = store.getSession(`zcode:${sessionId}`);
      if (!session) throw new Error('ZCode session 不存在');
      const workspace = String(session.project || '').trim();
      const launch = await launchZCodeWorkspace(workspace);
      const focus = await focusZCodeSessionWithUiAutomation({ sessionId, title: session.title, cwd: workspace });
      const ok = focus.status === 'ok';
      res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok, sessionId, workspace, windowVerified: launch.windowVerified, status: focus.status,
        ...(ok ? {} : { error: `ZCode 中未找到指定 session，脚本已结束（${focus.status}）` }),
      }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message || '无法打开 ZCode 会话' }));
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
      const credentialRepair = repairCredentialsFile();
      if (credentialRepair.error) throw new Error(`DeepSeek Desktop 凭据配置错误：${credentialRepair.error}`);
      if (credentialRepair.repaired) console.warn(`[deepseek] 已迁移旧凭据格式，备份：${credentialRepair.backupPath}`);
      const deepLink = sessionId ? buildDeepSeekDesktopDeepLink(sessionId) : '';
      const session = sessionId ? store.getSession(`deepseek:${sessionId}`) : true;
      if (!session) throw new Error('DeepSeek session 不存在');
      const desktopExe = resolveDeepSeekDesktopExe();
      if (process.platform === 'win32' && !fs.existsSync(desktopExe)) throw new Error(`未找到 DeepSeek Desktop：${desktopExe}`);
      const result = await ensureAppThenDeepLink({
        procName: AGENT_DEFS.deepseek.proc,
        launchExe: desktopExe,
        sendDeepLink: sessionId ? () => launchDetachedTargetPromise(desktopExe, [deepLink]) : null,
      });
      const ok = result.windowVerified !== false;
      res.writeHead(ok ? 200 : 502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok, sessionId, ...result, ...(ok ? {} : { error: 'DeepSeek Desktop 主窗口未确认出现，深链未能可靠跳转' }) }));
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
      if (process.platform === 'win32' && !fs.existsSync(desktopExe)) throw new Error(`未找到 Pi Agent Desktop：${desktopExe}`);
      const result = await ensureAppThenDeepLink({
        procName: AGENT_DEFS.pi.proc,
        launchExe: desktopExe,
        sendDeepLink: () => process.platform === 'win32'
          ? launchDetachedTargetPromise(desktopExe, [deepLink])
          : launchSchemeTargetPromise(deepLink),
      });
      const ok = result.windowVerified !== false;
      res.writeHead(ok ? 200 : 502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok, sessionId, ...result, ...(ok ? {} : { error: 'Pi Agent Desktop 主窗口未确认出现，深链未能可靠跳转' }) }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message || '无法打开 Pi Agent Desktop 会话' }));
    }
    return;
  }

  // 按 stored session id 打开 Hermes Desktop：先复用顶栏的启动/前台化逻辑，
  // 再把 hermes URI 作为启动参数交给单实例定位指定 session。
  if (pathname === '/api/open-hermes-session' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const sessionId = String(body.sessionId || '');
      if (!store.getSession(`hermes:${sessionId}`)) throw new Error('Hermes session 不存在');
      const launch = await launchHermesThenFocus();
      const deepLink = buildHermesDesktopDeepLink(sessionId);
      const desktopExe = resolveHermesDesktopExe();
      if (process.platform === 'win32' && !fs.existsSync(desktopExe)) throw new Error(`未找到 Hermes Desktop：${desktopExe}`);
      const deepLinkResult = process.platform === 'win32'
        ? await launchDetachedTargetPromise(desktopExe, [deepLink])
        : await launchSchemeTargetPromise(deepLink);
      // 深链交给 Hermes 单实例后再次确认主窗口，确保卡片点击不仅创建后台进程。
      const windowVerified = ['win32', 'darwin'].includes(process.platform)
        ? await waitForAppWindow('Hermes', 5000)
        : null;
      const result = { ...launch, ...(deepLinkResult || {}), action: 'launch-then-focus-then-locate', windowVerified };
      const ok = windowVerified !== false;
      res.writeHead(ok ? 200 : 502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok, sessionId, ...result, ...(ok ? {} : { error: 'Hermes Desktop 主窗口未确认出现，深链未能可靠跳转' }) }));
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
      const requestedTarget = typeof body.target === 'string' ? body.target.trim() : '';
      if (requestedTarget && requestedTarget !== 'cli' && requestedTarget !== 'desktop') {
        throw new Error('不支持的启动方式');
      }
      launchOrFocus(agent, requestedTarget, (r) => {
        console.log(`[launch-agent] ${agent} ->`, JSON.stringify(r));
        res.writeHead(r.ok ? 200 : 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ...r, agent }));
      });
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // 模型端口设置：返回自动识别的 CLI/桌面端目标和手动配置。
  if (pathname === '/api/launch-targets' && req.method === 'GET') {
    try {
      const automatic = await getAutomaticLaunchTargets();
      const overrides = launchLib.loadLaunchOverrides();
      const targets = {};
      for (const id of Object.keys(AGENT_DEFS)) {
        targets[id] = {
          ...(automatic[id] || {}),
          manualDesktop: overrides[id]?.manualDesktop || { enabled: false, target: '' },
        };
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ targets }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message || '自动目标探测失败' }));
    }
    return;
  }

  // 模型端口设置：读取当前的手动桌面端配置
  if (pathname === '/api/launch-overrides' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ overrides: launchLib.loadLaunchOverrides() }));
    return;
  }

  // 模型端口设置：保存/清除某个 agent 的手动桌面端配置
  if (pathname === '/api/launch-overrides' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const agent = String(body.agent || '');
      if (!AGENT_DEFS[agent]) throw new Error('未知 agent: ' + agent);
      const legacyCommand = typeof body.command === 'string' ? body.command.trim() : null;
      const target = legacyCommand !== null
        ? legacyCommand
        : (typeof body.target === 'string' ? body.target.trim() : '');
      const enabled = legacyCommand !== null ? Boolean(legacyCommand) : body.enabled === true;
      const overrides = launchLib.saveLaunchOverride(agent, { enabled, target });
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

  // AI 监督器/自动托管的只读目标解析：只允许唯一、明确可控的主会话进入后续指令链路。
  // 这里只做定位，不在本阶段发送指令；子代理、未知资格和多主会话都会返回阻断原因。
  if (pathname === '/api/session-control-target' && req.method === 'GET') {
    const result = store.resolveSessionControlTarget({
      agent: url.searchParams.get('agent') || '',
      project: url.searchParams.get('project') || '',
      sessionRef: url.searchParams.get('sessionRef') || '',
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
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
    // 探测包含多个同步版本命令，首次执行可能跨越数秒；看板首屏不能等待它。
    // 没有缓存时先按已有数据返回，探测完成后由 SSE 触发一次轻量刷新。
    const probed = probeCache.data || {};
    const defaultAgentIds = [...agentIds].filter((id) => (probed[id] && probed[id].installed) || agentsWithData.has(id));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    // liveRefs：当前实时活跃的 session ref 集合（getActive 按 10 分钟窗口），供前端渲染状态用
    res.end(JSON.stringify({
      groups, agentIds: [...agentIds], defaultAgentIds,
      liveRefs: store.getActive().map((a) => a.sessionRef),
      runtimeStatuses: store.getRuntimeStatuses(),
    }));
    if (!probeCache.data && !probeInFlight) {
      setImmediate(() => {
        getProbe().then(() => sseBroadcast('probe', {})).catch(() => {});
      });
    }
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
      if (process.platform !== 'win32') {
        throw new Error('当前版本的 CLI 恢复终端仅支持 Windows；请直接打开对应项目目录和 Agent Desktop');
      }
      // 构造 resume 命令
      let innerCmd;
      if (agent === 'claude') innerCmd = `claude --resume ${sessionId}`;
      else if (agent === 'codex') innerCmd = `codex resume ${sessionId}`;
      else innerCmd = `echo 此 agent 无 CLI 恢复命令，请打开 ${project || s.project} 目录`;
      const quotedPath = '"' + project.replace(/"/g, '') + '"';
      // 用 cmd /c start 开新窗口，/K 保持窗口；外层 cmd /c 启动后即退出
      const full = `start "Agent Board" cmd /K "cd /d ${quotedPath} && ${innerCmd}"`;
      await execCommand(full, { shell: 'cmd.exe', windowsHide: false });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, action: 'terminal-dispatched', command: full }));
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
          if (scheme) launchSchemeTarget(scheme, () => {});
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
    // 稍等一帧让响应先发出，再开始后台重扫
    setTimeout(async () => {
      try {
        // 非破坏式全量重扫：只清理各数据源的读取偏移，保留旧卡片。
        // Marvis/其他 SQLite 数据源可能在 WAL 切换时暂时不可读，不能因一次重扫失败把看板清空。
        store.clearOffsets();
        await scanAll({ full: true });
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

  // AI 安装：AI 只负责在固定 Agent 定义中选择动作；实际 CLI 命令由
  // lib/agent-installer.js 的白名单执行，桌面端只返回官方下载页。
  // API Key 仅存在本次请求的内存和请求头中，不写入 Agent Board 配置。
  if (pathname === '/api/agent-installer/run' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const result = await runAgentInstall({
        agentId: body.agentId,
        provider: body.provider,
        model: body.model,
        baseUrl: body.baseUrl,
        apiKey: body.apiKey,
      });
      if (result.ok && result.action === 'install') probeCache = { data: null, ts: 0 };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message || 'AI 安装失败' }));
    }
    return;
  }

  // 应用探测：返回每个 agent 的安装/探测状态（设置页"应用管理"用）
  if (pathname === '/api/agents/status') {
    try {
      const probed = await getProbe(url.searchParams.get('force') === '1');
      const byId = Object.fromEntries(PROBE_ADAPTERS.map((a) => [a.ID, a]));
      const agents = {};
      for (const [id, r] of Object.entries(probed)) {
        const target = byId[id] || {};
        const meta = AGENT_DEFS[id] || target.meta || {};
        const configured = detect.loadUserOverrides()[id] || {};
        // 应用管理只提供官方下载入口，不在 Agent Board 内执行第三方安装命令。
        const def = target.detect || {};
        let install = null;
        if (def.install) {
          const download = (def.install.methods || []).find((method) => method.kind === 'download');
          install = {
            ...def.install,
            downloadUrl: download ? download.url : null,
          };
        }
        agents[id] = {
          ...r,
          name: meta.name || id, icon: meta.icon || '', color: meta.color || '#888',
          manualOverride: {
            cli: Array.isArray(configured.cli) && configured.cli.length > 0,
            desktop: Array.isArray(configured.desktop) && configured.desktop.length > 0,
          },
          manualPaths: {
            cli: Array.isArray(configured.cli) ? configured.cli : [],
            desktop: Array.isArray(configured.desktop) ? configured.desktop : [],
          },
          probeOnly: Boolean(target.probeOnly),
          aiInstallable: AI_INSTALLABLE_IDS.has(id),
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

  // 应用管理：保存/清除某个 agent 的 CLI 或 Desktop 手动探测路径。
  if (pathname.startsWith('/api/agents/') && pathname.endsWith('/override-path') && req.method === 'POST') {
    const id = pathname.slice('/api/agents/'.length, -'/override-path'.length);
    const adapter = PROBE_ADAPTERS.find((a) => a.ID === id);
    if (!adapter || !adapter.detect) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '未知 agent: ' + id }));
      return;
    }
    try {
      const body = await readBody(req);
      const kind = body.kind === 'cli' ? 'cli' : 'desktop';
      const target = typeof body.path === 'string'
        ? body.path.trim().replace(/^"(.*)"$/, '$1').slice(0, 500)
        : '';
      if (target) {
        if (!path.isAbsolute(target)) throw new Error('请填写绝对路径（例如 D:\\deepseek\\DSH Desktop\\DSH Desktop.exe）');
        if (!/\.(exe|cmd|bat)$/i.test(target)) throw new Error('仅支持 .exe / .cmd / .bat 可执行文件');
      }
      const warning = target && !fs.existsSync(target)
        ? '文件当前不存在，已保存；文件出现后重新探测才会显示为已安装'
        : null;
      const overrides = kind === 'cli'
        ? detect.saveUserOverride(id, target)
        : detect.saveDesktopUserOverride(id, target);
      probeCache = { data: null, ts: 0 };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, agent: id, kind, path: target, warning, overrides }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message || '保存失败' }));
    }
    return;
  }

  // 强制重新读取本机路径/卸载注册表，并把真实可执行文件路径保存到用户配置。
  if (pathname.startsWith('/api/agents/') && pathname.endsWith('/discover-path') && req.method === 'POST') {
    const id = pathname.slice('/api/agents/'.length, -'/discover-path'.length);
    const adapter = PROBE_ADAPTERS.find((a) => a.ID === id);
    if (!adapter || !adapter.detect) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '未知 agent: ' + id }));
      return;
    }
    try {
      const probed = detect.probeAgent(adapter, { userOverrides: {} });
      if (probed.executablePath) {
        const kind = probed.tier === 'gui' ? 'desktop' : 'cli';
        const overrides = kind === 'desktop'
          ? detect.saveDesktopUserOverride(id, probed.executablePath)
          : detect.saveUserOverride(id, probed.executablePath);
        probeCache = { data: null, ts: 0 };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true, agent: id, kind, path: probed.executablePath,
          status: 'auto-path-discovered', overrides,
        }));
        return;
      }
      if (probed.desktopExecutablePath) {
        const overrides = launchLib.saveLaunchOverride(id, {
          enabled: true,
          target: probed.desktopExecutablePath,
        });
        probeCache = { data: null, ts: 0 };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true, agent: id, kind: 'desktop', path: probed.desktopExecutablePath,
          status: 'auto-path-discovered', overrides,
        }));
        return;
      }
      throw new Error(`未找到 ${AGENT_DEFS[id]?.name || id} 的 CLI 或 Desktop 可执行文件，请先完成安装`);
    } catch (e) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message || '未找到可执行文件' }));
    }
    return;
  }

  // 保留旧 API 路径，但行为改为只返回官方下载链接，不再执行 npm/winget/脚本。
  if (pathname.startsWith('/api/agents/') && pathname.endsWith('/install') && req.method === 'POST') {
    const id = pathname.slice('/api/agents/'.length, -'/install'.length);
    const adapter = PROBE_ADAPTERS.find((a) => a.ID === id);
    if (!adapter || !adapter.detect) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '未知 agent: ' + id }));
      return;
    }
    const download = (adapter.detect.install && adapter.detect.install.methods || [])
      .find((method) => method.kind === 'download' && /^https?:\/\//i.test(method.url || ''));
    if (!download) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '该 Agent 没有配置官方下载链接' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, downloadUrl: download.url }));
    return;
  }

  // 静态文件
  if (req.method === 'GET') {
    serveStatic(req, res, pathname);
    return;
  }
  res.writeHead(405, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Method Not Allowed' }));
});

async function runStartupTasks() {
  try {
    await scanAll();
    // 让首轮扫描完成后的 HTTP 请求先被处理，再执行兼容性维护任务。
    await new Promise((resolve) => setImmediate(resolve));
    codex.reconcileRecentCompletions(store);
    await new Promise((resolve) => setImmediate(resolve));
    // 兼容旧版本曾把 Codex 误判为进程退出而留下的停止标记；现在 Codex 以日志为准。
    store.setAgentStopped('codex', false, Date.now());
    // 修复存量数据里的 futCache：adapter 增/改了 system context 过滤规则后，旧入库的"系统注入"
    // 消息仍占着 userMsgFlag / futCache 首位，导致 board title 取到错误内容。
    store.repairUserQueries();
    // 服务停机期间已停笔的桌面会话：启动即判一次，无需等首个 20s 定时器
    try {
      workbuddy.checkDesktopIdle(store);
      deepseek.checkDesktopIdle(store);
    } catch { /* ignore */ }
  } catch (error) {
    console.error('[startup] 后台初始化失败:', error.message);
  }
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`┌──────────────────────────────────────────────┐`);
  console.log(`│  Agent Board · AI Agent 会话看板             │`);
  console.log(`│  打开: http://127.0.0.1:${PORT}                │`);
  console.log(`└──────────────────────────────────────────────┘`);
  ensureFocusDll().then(() => { initFocusPs(); console.log('[focus] 窗口激活进程就绪'); });
  startWatchers();
  console.log('[watch] 已开始监听:', ADAPTERS.filter((a) => fs.existsSync(a.ROOT)).map((a) => a.ID).join(', '));
  // 先让后端可用，再后台扫描/维护；前端可以立即加载已有快照。
  setImmediate(() => { runStartupTasks(); });
});
