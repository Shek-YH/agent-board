'use strict';
// Agent 探测引擎：判断某个 AI Agent 是否已安装、装在哪、版本号是多少。
// 只依赖 Node 内置模块，继续保持零 npm 依赖。
// 这轮只实现 Windows（win32）探测逻辑；probe.darwin/probe.linux 数据已经带上，留给以后跨平台用。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const USER_OVERRIDES_PATH = path.join(os.homedir(), '.agent-board', 'tool-paths.json');

// 展开路径模板里的 %ENV_VAR% 和开头的 ~
function expandPath(template, opts = {}) {
  const env = opts.env || process.env;
  const home = opts.home || os.homedir();
  let s = String(template).replace(/%([^%]+)%/g, (m, name) => {
    const v = env[name];
    return v != null ? v : m;
  });
  if (s === '~') s = home;
  else if (s.startsWith('~\\') || s.startsWith('~/')) s = path.join(home, s.slice(2));
  return s;
}

// 给一批候选路径模板，返回第一个真实存在的（展开后）；都不存在返回 null
function probePathList(templates, opts = {}) {
  for (const t of templates || []) {
    const p = expandPath(t, opts);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

module.exports = {
  expandPath, probePathList,
  USER_OVERRIDES_PATH,
};
