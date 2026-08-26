'use strict';

function buildExecutionPlan({ classification, goal }) {
  if (!classification || !['new', 'existing', 'existing_unversioned'].includes(classification.kind)) {
    throw new Error('invalid project classification');
  }
  const projectPath = classification.canonicalPath;
  const base = {
    projectPath,
    goal: String(goal || '').trim(),
    verification: ['git status --short'],
    preflight: [],
    actions: { createDirectory: false, initializeGit: false },
    requiresApproval: false,
    approvalReason: '',
  };
  if (classification.kind === 'new') {
    return {
      ...base,
      mode: 'new',
      actions: { createDirectory: !classification.exists, initializeGit: true },
    };
  }
  base.mode = 'maintenance';
  base.preflight = ['git status --short'];
  if (classification.kind === 'existing_unversioned') {
    base.requiresApproval = true;
    base.approvalReason = '现有项目尚未纳入 Git，初始化 Git 前需要人工确认';
  }
  return base;
}

module.exports = { buildExecutionPlan };
