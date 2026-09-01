'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { isInsideRoot } = require('./project-lifecycle');

const SECRET_FILE = /^(?:\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx|kdbx))$/i;

function contextError(code, message, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function defaultRunCommand(command, args, options) {
  const result = spawnSync(command, args, { ...options, encoding: 'utf8', windowsHide: true });
  return { code: result.status == null ? 1 : result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function existingPath(projectPath) {
  const raw = String(projectPath || '').trim();
  if (!raw) throw contextError('PROJECT_PATH_REQUIRED', '项目文件夹路径不能为空');
  const resolved = path.resolve(raw);
  try {
    return { resolved, canonical: fs.realpathSync(resolved), stat: fs.statSync(resolved) };
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      throw contextError('PROJECT_NOT_FOUND', '项目文件夹不存在', 404);
    }
    throw contextError('PROJECT_CONTEXT_UNREADABLE', '项目文件夹无法读取', 403);
  }
}

function safeGitProbe(projectPath, runCommand) {
  const probe = (args) => {
    try { return runCommand('git', ['-C', projectPath, ...args], { cwd: projectPath }); } catch { return { code: 1, stdout: '', stderr: '' }; }
  };
  const rootResult = probe(['rev-parse', '--show-toplevel']);
  if (rootResult.code !== 0 || !String(rootResult.stdout || '').trim()) {
    return { isGit: false, root: null, branch: null, dirty: false };
  }
  const branchResult = probe(['rev-parse', '--abbrev-ref', 'HEAD']);
  const dirtyResult = probe(['status', '--porcelain', '--untracked-files=no']);
  let gitRoot = path.resolve(String(rootResult.stdout).trim());
  try { gitRoot = fs.realpathSync(gitRoot); } catch { /* Git already verified the root; retain the safe resolved path. */ }
  return {
    isGit: true,
    root: gitRoot,
    branch: String(branchResult.stdout || '').trim().slice(0, 200) || null,
    dirty: dirtyResult.code === 0 && Boolean(String(dirtyResult.stdout || '').trim()),
  };
}

function validateProjectContext({ projectPath, allowedRoots = [], runCommand = defaultRunCommand } = {}) {
  const found = existingPath(projectPath);
  if (!found.stat.isDirectory()) throw contextError('PROJECT_NOT_DIRECTORY', '选择的路径不是文件夹', 422);
  if (allowedRoots.length && !allowedRoots.some((root) => isInsideRoot(found.canonical, root))) {
    throw contextError('PROJECT_OUTSIDE_ALLOWED_ROOTS', '项目文件夹不在预授权目录内', 403);
  }

  try { fs.accessSync(found.canonical, fs.constants.R_OK); } catch {
    throw contextError('PROJECT_NOT_READABLE', '项目文件夹不可读', 403);
  }
  try { fs.accessSync(found.canonical, fs.constants.W_OK); } catch {
    throw contextError('PROJECT_NOT_WRITABLE', '项目文件夹不可写', 403);
  }

  let entries;
  try { entries = fs.readdirSync(found.canonical, { withFileTypes: true }); } catch {
    throw contextError('PROJECT_NOT_READABLE', '项目文件夹不可读', 403);
  }
  const secretFiles = entries.filter((entry) => SECRET_FILE.test(entry.name)).map((entry) => entry.name).slice(0, 20);
  const git = safeGitProbe(found.canonical, runCommand);
  const warnings = [];
  if (!git.isGit) warnings.push('当前文件夹不是 Git 项目，后续变更无法获得 Git 版本边界。');
  if (git.dirty) warnings.push('当前 Git 项目存在未提交修改，自动执行前需要人工确认。');
  if (secretFiles.length) warnings.push('检测到可能包含敏感文件，默认不会读取或授权给 AutoPilot。');
  return {
    ok: true,
    projectPath: found.canonical,
    exists: true,
    isDirectory: true,
    readable: true,
    writable: true,
    git,
    secretFiles,
    warnings,
  };
}

module.exports = { SECRET_FILE, validateProjectContext };
