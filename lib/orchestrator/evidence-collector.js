'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const MAX_OUTPUT = 8_000;
const MAX_CHECKS = 12;
const SHELL_META = /[;&|><`$]/;
const BLOCKED_PATH = /(?:^|[\\/])(?:\.env(?:\.[^\\/]+)?|[^\\/]+\.(?:pem|key|p12|pfx))(?:$|[\\/])/i;

function text(value, max = 2_000) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function redact(value, max = MAX_OUTPUT) {
  return text(value, max)
    .replace(/((?:api[_ -]?key|oauth[_ -]?token|access[_ -]?token|refresh[_ -]?token|token|cookie|password|passwd|private[_ -]?key|authorization|prompt)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/(authorization\s*:\s*bearer\s+)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi, '[REDACTED]')
    .replace(/\b[A-Za-z]:[\\/][^\r\n`"'<>]+/g, '[LOCAL_PROJECT_PATH]')
    .split(/\r?\n/)
    .map((line) => BLOCKED_PATH.test(line) ? '[BLOCKED_PATH]' : line)
    .join('\n')
    .slice(0, max);
}

function defaultRunCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    ...options, encoding: 'utf8', windowsHide: true, shell: false, timeout: 30_000,
  });
  return {
    code: result.status == null ? 1 : result.status,
    stdout: result.stdout || '', stderr: result.stderr || '',
    timedOut: result.error && result.error.code === 'ETIMEDOUT',
  };
}

function parseCommand(value) {
  const command = text(value, 500);
  if (!command || SHELL_META.test(command)) return null;
  const parts = command.split(/\s+/).filter(Boolean);
  return parts.length ? { command: parts[0], args: parts.slice(1), display: command } : null;
}

function commandAllowed(display, allowedCommands) {
  const value = text(display, 500).toLowerCase();
  return (Array.isArray(allowedCommands) ? allowedCommands : [])
    .map((item) => text(item, 500).toLowerCase())
    .some((allowed) => allowed && (value === allowed || value.startsWith(`${allowed} `)));
}

function isTestOrCheckCommand(display) {
  return /^(?:node\s+--test|npm\s+(?:test|run\s+(?:lint|typecheck|check|build))|pnpm\s+(?:test|run\s+(?:lint|typecheck|check|build))|yarn\s+(?:test|lint|typecheck|build)|npx\s+(?:tsc|eslint|jest|vitest)\b)/i.test(display);
}

function safeResult({ kind, operation, command, result }) {
  const code = Number.isInteger(result && result.code) ? result.code : 1;
  const output = [result && result.stdout, result && result.stderr].filter(Boolean).join('\n').trim();
  return {
    kind: text(kind, 40), operation: text(operation, 60), command: redact(command, 500),
    status: result && result.timedOut ? 'timeout' : code === 0 ? 'pass' : 'fail',
    exitCode: code, output: redact(output),
  };
}

function sanitizeEvidenceSnapshot(snapshot) {
  const source = snapshot && typeof snapshot === 'object' ? snapshot : {};
  return {
    version: 1,
    collectedAt: Number.isFinite(source.collectedAt) ? source.collectedAt : Date.now(),
    checks: Array.isArray(source.checks) ? source.checks.slice(0, MAX_CHECKS).map((item) => ({
      kind: text(item && item.kind, 40), operation: text(item && item.operation, 60),
      command: redact(item && item.command, 500), status: text(item && item.status, 20),
      exitCode: Number.isInteger(item && item.exitCode) ? item.exitCode : 1,
      output: redact(item && item.output),
    })) : [],
    skipped: Array.isArray(source.skipped) ? source.skipped.slice(0, MAX_CHECKS).map((item) => ({
      kind: text(item && item.kind, 40), operation: text(item && item.operation, 60),
      command: redact(item && item.command, 500), reason: redact(item && item.reason, 300),
    })) : [],
  };
}

async function collectProjectEvidence({ workflow, runCommand = defaultRunCommand, now = () => Date.now() } = {}) {
  if (!workflow || typeof workflow !== 'object') throw new TypeError('workflow is required');
  const requestedProjectPath = String(workflow.projectPath || '').trim();
  if (!requestedProjectPath) throw new TypeError('projectPath is required');
  const projectPath = path.resolve(requestedProjectPath);
  const permission = workflow.permissionSnapshot && typeof workflow.permissionSnapshot === 'object'
    ? workflow.permissionSnapshot : {};
  const snapshot = { version: 1, collectedAt: now(), checks: [], skipped: [] };
  const checks = [];
  const addSkipped = (kind, operation, command, reason) => snapshot.skipped.push({ kind, operation, command, reason });
  const addCheck = async (kind, operation, command, args) => {
    if (checks.length >= MAX_CHECKS) return;
    try {
      const result = await runCommand(command, args, { cwd: projectPath, windowsHide: true, shell: false });
      const safe = safeResult({ kind, operation, command: [command, ...args].join(' '), result: result || {} });
      checks.push(safe);
      snapshot.checks.push(safe);
    } catch (error) {
      const safe = safeResult({ kind, operation, command: [command, ...args].join(' '), result: { code: 1, stderr: error.message } });
      checks.push(safe);
      snapshot.checks.push(safe);
    }
  };

  const allowedGit = permission.allowGit !== false;
  const gitOperations = (Array.isArray(permission.allowedGitOperations) ? permission.allowedGitOperations : [])
    .map((item) => String(item || '').trim().toLowerCase());
  const gitChecks = [
    ['status', ['status', '--short']],
    ['diff', ['diff', '--stat']],
    ['diff_names', ['diff', '--name-only']],
  ];
  for (const [operation, args] of gitChecks) {
    const normalizedOperation = operation === 'diff_names' ? 'diff' : operation;
    const command = `git ${args.join(' ')}`;
    if (!allowedGit) addSkipped('git', normalizedOperation, command, 'Permission Snapshot 禁止本地 Git');
    else if (!gitOperations.includes(normalizedOperation)) addSkipped('git', normalizedOperation, command, 'Git 操作不在 Permission Snapshot 白名单');
    else await addCheck('git', normalizedOperation, 'git', args);
  }

  const requestedEvidence = workflow.runContract && workflow.runContract.verify && workflow.runContract.verify.evidence;
  const allowedCommands = permission.allowedCommands || [];
  const seenCommands = new Set();
  for (const item of Array.isArray(requestedEvidence) ? requestedEvidence : []) {
    const parsed = parseCommand(item);
    if (!parsed || !isTestOrCheckCommand(parsed.display)) continue;
    if (seenCommands.has(parsed.display.toLowerCase())) continue;
    seenCommands.add(parsed.display.toLowerCase());
    if (permission.allowTests !== true) {
      addSkipped('command', 'test', parsed.display, 'Permission Snapshot 禁止测试或检查命令');
      continue;
    }
    if (!commandAllowed(parsed.display, allowedCommands)) {
      addSkipped('command', 'test', parsed.display, '命令不在 Permission Snapshot 白名单');
      continue;
    }
    await addCheck('command', 'test', parsed.command, parsed.args);
  }
  return sanitizeEvidenceSnapshot(snapshot);
}

module.exports = { collectProjectEvidence, defaultRunCommand, parseCommand, sanitizeEvidenceSnapshot };
