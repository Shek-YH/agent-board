'use strict';

const fs = require('node:fs');
const path = require('node:path');

function isInsideRoot(projectPath, root) {
  const relative = path.relative(path.resolve(root), path.resolve(projectPath));
  return relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function defaultRunCommand(command, args, options) {
  const { spawnSync } = require('node:child_process');
  const result = spawnSync(command, args, { ...options, encoding: 'utf8', windowsHide: true });
  return { code: result.status == null ? 1 : result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function executeProjectPlan(plan, { allowedRoots = [], runCommand = defaultRunCommand } = {}) {
  const projectPath = path.resolve(plan.projectPath);
  if (!allowedRoots.some((root) => isInsideRoot(projectPath, root))) throw new Error('project outside allowed roots');
  if (plan.requiresApproval) throw new Error('approval required: ' + plan.approvalReason);

  if (plan.actions.createDirectory) fs.mkdirSync(projectPath, { recursive: true });
  if (plan.actions.initializeGit) {
    const init = runCommand('git', ['init'], { cwd: projectPath });
    if (init.code !== 0) throw new Error(`git init failed: ${init.stderr || init.stdout || init.code}`);
  }

  const preflight = plan.preflight && plan.preflight.length ? plan.preflight : (plan.verification || []);
  for (const check of preflight) {
    const parts = check.split(/\s+/);
    const result = runCommand(parts[0], parts.slice(1), { cwd: projectPath });
    if (result.code !== 0) throw new Error(`preflight failed: ${result.stderr || result.stdout || result.code}`);
    if (check === 'git status --short' && String(result.stdout || '').trim()) {
      return { status: 'waiting_user', reason: '项目存在未提交修改，自动执行前需要人工确认', projectPath };
    }
  }
  return { status: 'ready', projectPath };
}

module.exports = { executeProjectPlan, isInsideRoot };
