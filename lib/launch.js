'use strict';
// 启动覆盖 + 端口探测：模型端口设置功能用（~/.agent-board/launch-overrides.json）。
// 和 lib/detect.js 的 loadUserOverrides（tool-paths.json）是同一套"机器级配置、容错读写"
// 思路，但两个文件功能不同（一个覆盖探测路径、一个覆盖启动命令），故意不合并成一个文件。
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');

const LAUNCH_OVERRIDES_PATH = path.join(os.homedir(), '.agent-board', 'launch-overrides.json');

// 读取启动覆盖表：文件不存在/JSON 解析失败/字段类型不对，一律降级成空对象，绝不能让跳转流程崩溃
function loadLaunchOverrides(filePath = LAUNCH_OVERRIDES_PATH) {
  try {
    if (!fs.existsSync(filePath)) return {};
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out = {};
    for (const [id, v] of Object.entries(raw)) {
      if (typeof v === 'string' && v.trim()) out[id] = v;
    }
    return out;
  } catch {
    return {};
  }
}

// 保存一个 agent 的启动覆盖；command 为空/空白字符串 = 清除该 agent 的覆盖。返回保存后的完整表。
function saveLaunchOverride(agent, command, filePath = LAUNCH_OVERRIDES_PATH) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const cur = loadLaunchOverrides(filePath);
  if (command && command.trim()) cur[agent] = command.trim();
  else delete cur[agent];
  fs.writeFileSync(filePath, JSON.stringify(cur, null, 2));
  return cur;
}

module.exports = { LAUNCH_OVERRIDES_PATH, loadLaunchOverrides, saveLaunchOverride };
