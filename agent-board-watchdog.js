'use strict';
// Agent Board 常驻看门狗（node 版）：每 30 秒 Ping 一次 4876，挂了就自动拉起 server.js
// 启动方式：node agent-board-watchdog.js （隐藏窗口后台运行）
// 随登录启动：Startup 文件夹里的 "Agent Board 看板-守护.bat" 调用本脚本。
// 如需停止：任务管理器结束 node.exe（agent-board-watchdog.js 对应的那个）即可。
const fs = require('fs');
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const { getDataDir } = require('./lib/runtime-paths');
const { readRuntimeMarker, matchesRuntimeIdentity } = require('./lib/runtime-marker');

const PORT = Number(process.env.AB_PORT || 4876);
const WORKDIR = path.resolve(__dirname);
const bundledNode = path.join(WORKDIR, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
const NODE = process.env.AGENTBOARD_NODE || (fs.existsSync(bundledNode) ? bundledNode : process.execPath || 'node');
const SERVER = path.join(WORKDIR, 'server.js');
const INTERVAL_MS = 30 * 1000;

let restarting = false;

function ping(port = PORT, expectedMarker = null) {
  return new Promise((resolve) => {
    const chunks = [];
    const req = http.get({ host: '127.0.0.1', port, path: '/api/state', timeout: 3000 }, (res) => {
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        if (res.statusCode !== 200) { resolve(false); return; }
        if (!expectedMarker) { resolve(true); return; }
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve(matchesRuntimeIdentity(body.runtime, expectedMarker));
        } catch { resolve(false); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

async function isServerAvailable({ dataDir = getDataDir(), pingImpl = ping } = {}) {
  const marker = readRuntimeMarker({ dataDir });
  if (marker?.port && await pingImpl(marker.port, marker)) return true;
  return pingImpl(PORT);
}

function startServer() {
  if (restarting) return;
  restarting = true;
  console.log(`[watchdog] ${new Date().toLocaleString()} server 不可用，正在拉起...`);
  const child = spawn(NODE, [SERVER], {
    cwd: WORKDIR,
    windowsHide: true,
    detached: false,
    stdio: 'ignore',
    env: { ...process.env, AB_PORT: String(PORT), AB_RUNTIME: 'watchdog' },
  });
  child.on('error', (e) => console.error('[watchdog] 启动失败:', e.message));
  // 等 server 起来（最多 25 秒）
  const deadline = Date.now() + 25 * 1000;
  const wait = setInterval(async () => {
    if (await isServerAvailable()) {
      clearInterval(wait);
      restarting = false;
      console.log(`[watchdog] ${new Date().toLocaleString()} server 已恢复 (pid ${child.pid})`);
    } else if (Date.now() > deadline) {
      clearInterval(wait);
      restarting = false;
      console.error('[watchdog] server 启动超时，30 秒后重试');
    }
  }, 1000);
}

async function main() {
  console.log('[watchdog] Agent Board 守护启动，每 30 秒检查一次...');
  let fails = 0;
  while (true) {
    const ok = await isServerAvailable();
    if (ok) {
      fails = 0;
    } else {
      fails++;
      // 连续 2 次 Ping 失败才重启（Ping 偶尔超时，避免误判）
      if (fails >= 2) {
        startServer();
        fails = 0;
      }
    }
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
}

if (require.main === module) main();

module.exports = { ping, isServerAvailable, startServer };
