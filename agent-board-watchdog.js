'use strict';
// Agent Board 常驻看门狗（node 版）：每 30 秒 Ping 一次 4876，挂了就自动拉起 server.js
// 启动方式：node agent-board-watchdog.js （隐藏窗口后台运行）
// 随登录启动：Startup 文件夹里的 "Agent Board 看板-守护.bat" 调用本脚本。
// 如需停止：任务管理器结束 node.exe（agent-board-watchdog.js 对应的那个）即可。
const { execFile, spawn } = require('child_process');
const http = require('http');
const path = require('path');
const os = require('os');

const PORT = 4876;
const NODE = process.env.AGENTBOARD_NODE || 'C:\\Program Files\\nodejs\\node.exe';
const WORKDIR = path.join(os.homedir(), 'WorkBuddy', '2026-08-20-03-52-10', 'agent-board');
const SERVER = path.join(WORKDIR, 'server.js');
const INTERVAL_MS = 30 * 1000;

let restarting = false;

function ping() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/state', timeout: 3000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
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
  });
  child.on('error', (e) => console.error('[watchdog] 启动失败:', e.message));
  // 等 server 起来（最多 25 秒）
  const deadline = Date.now() + 25 * 1000;
  const wait = setInterval(async () => {
    if (await ping()) {
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
    const ok = await ping();
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

main();
