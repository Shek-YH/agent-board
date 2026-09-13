'use strict';
// 启动覆盖 + 端口探测：模型端口设置功能用（~/.agent-board/launch-overrides.json）。
// 和 lib/detect.js 的 loadUserOverrides（tool-paths.json）是同一套"机器级配置、容错读写"
// 思路，但两个文件功能不同（一个覆盖探测路径、一个覆盖启动命令），故意不合并成一个文件。
const fs = require('fs');
const path = require('path');
const net = require('net');
const { getConfigDir } = require('./runtime-paths');

const LAUNCH_OVERRIDES_PATH = path.join(getConfigDir(), 'launch-overrides.json');

// 把旧版字符串命令和新版手动桌面端对象统一成同一个内部结构。
function normalizeOverride(value) {
  if (typeof value === 'string' && value.trim()) {
    return { manualDesktop: { enabled: true, target: value.trim() } };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const manual = value.manualDesktop;
  if (!manual || typeof manual !== 'object' || Array.isArray(manual)) return null;
  const target = typeof manual.target === 'string' ? manual.target.trim() : '';
  if (!target) return null;
  return { manualDesktop: { enabled: manual.enabled === true, target } };
}

// 读取启动覆盖表：文件不存在/JSON 解析失败/字段类型不对，一律降级成空对象，绝不能让跳转流程崩溃
function loadLaunchOverrides(filePath = LAUNCH_OVERRIDES_PATH) {
  try {
    if (!fs.existsSync(filePath)) return {};
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out = {};
    for (const [id, v] of Object.entries(raw)) {
      const normalized = normalizeOverride(v);
      if (normalized) out[id] = normalized;
    }
    return out;
  } catch {
    return {};
  }
}

// 保存一个 agent 的手动桌面端配置；target 为空 = 清除该 agent 的覆盖。返回保存后的完整表。
function saveLaunchOverride(agent, override, filePath = LAUNCH_OVERRIDES_PATH) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const cur = loadLaunchOverrides(filePath);
  const candidate = override && typeof override === 'object' && !Array.isArray(override)
    && Object.prototype.hasOwnProperty.call(override, 'target')
    ? { manualDesktop: override }
    : override;
  const normalized = normalizeOverride(candidate);
  if (normalized) cur[agent] = normalized;
  else delete cur[agent];
  fs.writeFileSync(filePath, JSON.stringify(cur, null, 2));
  return cur;
}

function getManualDesktopOverride(overrides, agent) {
  const manual = overrides?.[agent]?.manualDesktop;
  return manual?.enabled === true && manual.target ? { ...manual } : null;
}

// TCP 探测某端口是否已经有服务在监听。timeoutMs 内探测不到（连接超时/被拒绝）都算「没监听」，
// 不抛异常——探测失败本身就是一个正常、常见的结果，不是错误。
function probePort(port, host = '127.0.0.1', timeoutMs = 400, connect = net.connect) {
  return new Promise((resolve) => {
    const socket = connect({ port, host });
    const done = (ok) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

// 轮询探测端口，直到监听到或超时。opts.probeFn 可注入（测试用，同 lib/detect.js 的依赖注入模式），
// 默认是真实的 probePort。
function waitForPort(port, host = '127.0.0.1', opts = {}) {
  const intervalMs = opts.intervalMs || 500;
  const timeoutMs = opts.timeoutMs || 8000;
  const probe = opts.probeFn || probePort;
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const tick = async () => {
      if (await probe(port, host)) { resolve(true); return; }
      if (Date.now() >= deadline) { resolve(false); return; }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

module.exports = {
  LAUNCH_OVERRIDES_PATH,
  normalizeOverride,
  loadLaunchOverrides,
  saveLaunchOverride,
  getManualDesktopOverride,
  probePort,
  waitForPort,
};
