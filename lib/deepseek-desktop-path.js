'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadUserOverrides, getOverridePaths } = require('./detect');

function resolveDeepSeekDesktopExe({
  env = process.env,
  homedir = os.homedir(),
  platform = process.platform,
  existsSync = fs.existsSync,
  userOverrides,
} = {}) {
  const pathApi = platform === 'darwin' ? path.posix : path;
  const macCandidates = [
    '/Applications/DSH Desktop.app/Contents/MacOS/DSH Desktop',
    pathApi.join(homedir, 'Applications', 'DSH Desktop.app', 'Contents', 'MacOS', 'DSH Desktop'),
    '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness',
  ];
  const candidates = [
    ...getOverridePaths(userOverrides || loadUserOverrides(), 'deepseek', 'desktop'),
    env.DEEPSEEK_DESKTOP_EXE,
    ...(platform === 'darwin' ? macCandidates : []),
    pathApi.join(homedir, 'AppData', 'Local', 'Programs', 'DSH Desktop', 'DSH Desktop.exe'),
    pathApi.join(homedir, 'AppData', 'Local', 'DSH Desktop', 'DSH Desktop.exe'),
    pathApi.join(homedir, 'AppData', 'Local', 'DeepSeek Harness', 'DeepSeek Harness.exe'),
    'D:\\deepseek\\DSH Desktop\\DSH Desktop.exe',
  ].filter(Boolean);
  return candidates.find(file => existsSync(file)) || '';
}

module.exports = { resolveDeepSeekDesktopExe };
