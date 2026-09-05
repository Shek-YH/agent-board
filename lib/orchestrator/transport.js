'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

// 只保留经过明确适配的 headless CLI。模型输出不能改变 command 或 args 的结构。
const HEADLESS_PROFILES = {
  claude: {
    command: 'claude',
    args: ({ prompt, sessionRef }) => [
      '-p', prompt, '--output-format', 'stream-json',
      ...(sessionRef ? ['--resume', sessionRef] : []),
    ],
  },
  codex: {
    command: 'codex',
    args: ({ prompt }) => ['exec', '--json', prompt],
  },
};
const KNOWN_AGENTS = new Set(['claude', 'codex', 'workbuddy', 'deepseek', 'pi', 'hermes', 'zcode']);
const HEADLESS_CAPABILITY_AGENTS = new Set(['claude', 'workbuddy']);
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
const TRUSTED_WORKBUDDY_CLI_NAMES = new Set(['codebuddy', 'codebuddy.cmd', 'codebuddy.exe']);
const TRUSTED_CLAUDE_CLI_NAMES = new Set(['claude', 'claude.cmd', 'claude.exe']);
const TRUSTED_NODE_NAMES = new Set(['node', 'node.exe', 'nodejs', 'nodejs.exe']);

function hash(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex').slice(0, 32);
}

function projectIdentity(value) {
  try { return path.resolve(String(value || '').trim()).replace(/\\/g, '/').toLowerCase(); } catch { return ''; }
}

function pathBaseName(value) {
  return String(value || '').replace(/\\/g, '/').split('/').pop().toLowerCase();
}

function sessionIdFromRef(agent, sessionRef) {
  const value = String(sessionRef || '').trim();
  const prefix = `${agent}:`;
  if (value.includes(':') && !value.startsWith(prefix)) throw new Error('invalid headless session reference');
  const id = value.startsWith(prefix) ? value.slice(prefix.length) : value;
  if (!SAFE_SESSION_ID.test(id)) throw new Error('invalid headless session reference');
  return id;
}

function safeWorkingDirectory(projectPath, allowedRoots = []) {
  const value = String(projectPath || '').trim();
  if (!value || /[\r\n\t]/.test(value)) throw new Error('safe project working directory is required');
  const cwd = path.resolve(value);
  const roots = Array.isArray(allowedRoots) ? allowedRoots.filter(Boolean).map((root) => path.resolve(String(root))) : [];
  if (roots.length && !roots.some((root) => {
    const relative = path.relative(root, cwd);
    return relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  })) throw new Error('project working directory is outside allowed roots');
  return cwd;
}

function resolveWorkBuddyCliPath({ desktopExecutable = '', env = process.env, existsSync = fs.existsSync } = {}) {
  const candidates = [];
  if (String(env.AGENT_BOARD_WORKBUDDY_CLI || '').trim()) candidates.push(String(env.AGENT_BOARD_WORKBUDDY_CLI).trim());
  if (String(desktopExecutable || '').trim()) {
    candidates.push(path.join(path.dirname(String(desktopExecutable)), 'resources', 'app.asar.unpacked', 'cli', 'bin', 'codebuddy'));
  }
  for (const root of [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs')]) {
    if (!String(root || '').trim()) continue;
    candidates.push(path.join(String(root), 'WorkBuddy', 'resources', 'app.asar.unpacked', 'cli', 'bin', 'codebuddy'));
  }
  return candidates.find((candidate) => {
    try { return Boolean(existsSync(candidate)); } catch { return false; }
  }) || null;
}

function buildHeadlessInvocation({ agent, projectPath, prompt, sessionRef = '', workbuddyCliPath, claudeCliPath, nodeExecutable = process.execPath, allowedRoots = [] }) {
  const agentId = String(agent || '').trim().toLowerCase();
  const profile = HEADLESS_PROFILES[agentId];
  if (!profile) {
    if (agentId !== 'workbuddy') {
      if (!KNOWN_AGENTS.has(agentId)) throw new Error('unsupported agent for headless execution');
      throw new Error('headless profile is not configured');
    }
  }
  const text = String(prompt || '').trim();
  if (!text) throw new Error('execution prompt is required');
  if (text.length > 200_000) throw new Error('execution prompt is too large');
  const cwd = safeWorkingDirectory(projectPath, allowedRoots);
  if (agentId === 'workbuddy') {
    const cliPath = String(workbuddyCliPath || '').trim();
    if (!cliPath) throw new Error('headless profile is not configured');
    if (!TRUSTED_WORKBUDDY_CLI_NAMES.has(pathBaseName(cliPath))) throw new Error('WorkBuddy CLI path is not trusted');
    if (!TRUSTED_NODE_NAMES.has(pathBaseName(nodeExecutable))) throw new Error('Node executable is not trusted');
    return {
      command: nodeExecutable,
      args: [cliPath, '--print', '--output-format', 'json', '--max-turns', '3', text],
      cwd,
      options: { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    };
  }
  const cliPath = String(claudeCliPath || '').trim();
  if (cliPath && !TRUSTED_CLAUDE_CLI_NAMES.has(pathBaseName(cliPath))) throw new Error('Claude CLI path is not trusted');
  const normalizedSessionRef = sessionRef ? sessionIdFromRef(agentId, sessionRef) : '';
  return {
    command: cliPath || profile.command,
    args: profile.args({ prompt: text, sessionRef: normalizedSessionRef }),
    cwd,
    options: { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  };
}

class HeadlessTransport {
  constructor({ enabled = false, env = process.env, spawnImpl = spawn, workbuddyCliPath = '', nodeExecutable = process.execPath } = {}) {
    this.enabled = Boolean(enabled && env && env.AGENT_BOARD_HEADLESS_EXECUTION === '1');
    this.spawnImpl = spawnImpl;
    this.workbuddyCliPath = workbuddyCliPath;
    this.nodeExecutable = nodeExecutable;
  }

  run({ agent, projectPath, prompt, sessionRef, claudeCliPath, allowedRoots }) {
    if (!this.enabled) {
      return Promise.resolve({ status: 'waiting_user', reason: 'headless execution is disabled' });
    }
    const invocation = buildHeadlessInvocation({
      agent, projectPath, prompt, workbuddyCliPath: this.workbuddyCliPath, nodeExecutable: this.nodeExecutable,
      sessionRef, claudeCliPath, allowedRoots,
    });
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        resolve({ ...result, stdout, stderr });
      };
      let child;
      try {
        child = this.spawnImpl(invocation.command, invocation.args, invocation.options);
      } catch (error) {
        finish({ status: 'failed', code: 1, error: error.message });
        return;
      }
      child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
      child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
      child.once('error', (error) => finish({ status: 'failed', code: 1, error: error.message }));
      child.once('close', (code) => finish({ status: code === 0 ? 'completed' : 'failed', code, error: code === 0 ? '' : (stderr || `exit ${code}`) }));
    });
  }
}

function headlessTargetError(agent, target) {
  if (!HEADLESS_CAPABILITY_AGENTS.has(agent)) return 'headless capability is not configured for this agent';
  if (!target || String(target.agent || '').trim().toLowerCase() !== agent) return 'headless target Agent identity is invalid';
  if (!String(target.sessionRef || '').trim()) return 'headless target session identity is required';
  if (!String(target.project || '').trim()) return 'headless target project is required';
  if (target.role !== 'main' || target.controlEligibility !== 'eligible') return 'headless target is not an eligible main session';
  try { sessionIdFromRef(agent, target.sessionRef); } catch { return 'headless target session identity is invalid'; }
  return '';
}

function createHeadlessIdentityVerifier(agent) {
  return async (target) => {
    const error = headlessTargetError(agent, target);
    if (error) return { ok: false, strongAnchor: false, code: 'SESSION_IDENTITY_UNVERIFIED', reason: error };
    return {
      ok: true,
      strongAnchor: true,
      anchor: hash(`${agent}|${target.sessionRef}|${projectIdentity(target.project)}`),
      source: 'headless-session-binding',
    };
  };
}

function parseJsonRecords(stdout) {
  const raw = String(stdout || '').trim();
  if (!raw) return [];
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const records = [];
  for (const line of lines) {
    try {
      const value = JSON.parse(line);
      if (value && typeof value === 'object' && !Array.isArray(value)) records.push(value);
    } catch { /* stream-json may include a non-JSON diagnostic line; ignore it safely */ }
  }
  if (!records.length) {
    try {
      const value = JSON.parse(raw);
      if (value && typeof value === 'object' && !Array.isArray(value)) records.push(value);
    } catch { /* unparseable output is not delivery evidence */ }
  }
  return records;
}

function vendorSessionId(agent, record) {
  const value = record && (record.session_id || record.sessionId);
  if (typeof value !== 'string' || !value.trim()) return '';
  try { return sessionIdFromRef(agent, value); } catch { return ''; }
}

function verifyHeadlessExecution(agent, target, result, message = '') {
  if (!result || result.status !== 'completed') {
    return { ok: false, code: 'HEADLESS_EXECUTION_FAILED', reason: 'headless Agent 未完成执行' };
  }
  const records = parseJsonRecords(result.stdout);
  const expected = sessionIdFromRef(agent, target.sessionRef);
  const matched = records.find((record) => {
    const sessionId = vendorSessionId(agent, record);
    if (sessionId !== expected) return false;
    if (agent === 'claude') {
      const isError = record.is_error === true || String(record.is_error || '').trim().toLowerCase() === 'true';
      return record.type === 'result' && !isError;
    }
    const status = String(record.status || record.state || '').trim().toLowerCase();
    return record.delivered === true && (status === 'completed' || status === 'success' || status === 'done');
  });
  if (!matched) return { ok: false, code: 'DELIVERY_UNVERIFIED', reason: 'headless 输出未提供匹配目标 Session 的送达证据' };
  return {
    ok: true,
    delivered: true,
    deliveryProof: {
      verified: true,
      delivered: true,
      source: agent === 'claude' ? 'claude-stream-json' : 'workbuddy-cli-json',
      sessionIdFingerprint: hash(expected),
      messageFingerprint: hash(message),
      outputFingerprint: hash(result.stdout),
    },
  };
}

function createHeadlessCapabilityBinding({
  agent, enabled = false, workbuddyCliPath = '', claudeCliPath = '', nodeExecutable = process.execPath,
  allowedRoots = [], runner = null, env = process.env,
} = {}) {
  const agentId = String(agent || '').trim().toLowerCase();
  if (!HEADLESS_CAPABILITY_AGENTS.has(agentId)) return { supported: false, reason: 'headless capability is not configured for this agent' };
  if (enabled !== true || (!runner && (!env || env.AGENT_BOARD_HEADLESS_EXECUTION !== '1'))) {
    return { supported: false, reason: 'headless execution is disabled' };
  }
  if (agentId === 'workbuddy' && !String(workbuddyCliPath || '').trim()) return { supported: false, reason: 'WorkBuddy CLI path is not configured' };
  const transport = runner && typeof runner.run === 'function' ? runner : new HeadlessTransport({
    enabled: true, env, workbuddyCliPath, nodeExecutable,
  });
  const identityVerifier = createHeadlessIdentityVerifier(agentId);
  const targetFingerprint = (target) => hash(`${agentId}|${sessionIdFromRef(agentId, target.sessionRef)}|${projectIdentity(target.project)}`);
  const drafts = new Map();
  const writer = {
    async write(target, message) {
      const error = headlessTargetError(agentId, target);
      const text = String(message == null ? '' : message);
      if (error) return { ok: false, code: 'SESSION_IDENTITY_UNVERIFIED', reason: error };
      if (!text.trim()) return { ok: false, code: 'EMPTY_MESSAGE', reason: '消息不能为空' };
      let invocation;
      try {
        invocation = buildHeadlessInvocation({
          agent: agentId, projectPath: target.project, prompt: text, sessionRef: target.sessionRef,
          workbuddyCliPath, claudeCliPath, nodeExecutable, allowedRoots,
        });
      } catch (cause) {
        return { ok: false, code: 'HEADLESS_INVOCATION_INVALID', reason: cause.message };
      }
      drafts.set(target.sessionRef, { message: text, invocation, targetFingerprint: targetFingerprint(target) });
      return { ok: true, matches: true, source: 'headless-argv', messageFingerprint: hash(text) };
    },
    async verifyDraft(target, message) {
      const targetError = headlessTargetError(agentId, target);
      if (targetError) return { ok: false, matches: false, code: 'IDENTITY_DRIFT', reason: targetError };
      const draft = drafts.get(target && target.sessionRef);
      return draft && draft.targetFingerprint === targetFingerprint(target) && draft.message === String(message == null ? '' : message)
        ? { ok: true, matches: true, source: 'headless-draft-buffer', messageFingerprint: hash(draft.message) }
        : { ok: false, matches: false, code: draft ? 'IDENTITY_DRIFT' : 'DRAFT_MISMATCH', reason: draft ? 'headless 草稿目标身份发生变化' : 'headless 草稿不存在或内容发生变化' };
    },
    async send(target, context = {}) {
      const draft = drafts.get(target && target.sessionRef);
      if (!draft) return { ok: false, code: 'DRAFT_MISSING', reason: 'headless 草稿不存在' };
      drafts.delete(target.sessionRef);
      const targetError = headlessTargetError(agentId, target);
      if (targetError) return { ok: false, code: 'IDENTITY_DRIFT', reason: targetError };
      if (draft.targetFingerprint !== targetFingerprint(target)) {
        return { ok: false, code: 'IDENTITY_DRIFT', reason: 'headless 草稿目标身份发生变化' };
      }
      const requestedMessage = context && context.request && context.request.message;
      if (requestedMessage !== undefined && String(requestedMessage) !== draft.message) {
        return { ok: false, code: 'DRAFT_MISMATCH', reason: 'headless 发送消息与已验证草稿不一致' };
      }
      let result;
      try {
        result = await transport.run({
          agent: agentId, projectPath: target.project, prompt: draft.message, sessionRef: target.sessionRef,
          invocation: draft.invocation,
        });
      } catch {
        return { ok: false, code: 'HEADLESS_EXECUTION_FAILED', reason: 'headless Agent 执行失败' };
      }
      const evidence = verifyHeadlessExecution(agentId, target, result, draft.message);
      return evidence.ok ? { ok: true, sent: true, deliveryProof: evidence.deliveryProof } : evidence;
    },
  };
  const deliveryVerifier = {
    async verify(target, message, context = {}) {
      const sent = context.sent;
      if (!sent || sent.ok !== true || !sent.deliveryProof || sent.deliveryProof.verified !== true
      || sent.deliveryProof.delivered !== true) return { ok: false, delivered: false, code: 'DELIVERY_UNVERIFIED', reason: 'headless 发送缺少可验证送达证据' };
      const targetError = headlessTargetError(agentId, target);
      if (targetError) return { ok: false, delivered: false, code: 'IDENTITY_DRIFT', reason: targetError };
      if (sent.deliveryProof.sessionIdFingerprint !== hash(sessionIdFromRef(agentId, target.sessionRef))) {
        return { ok: false, delivered: false, code: 'IDENTITY_DRIFT', reason: 'headless 送达证据的目标 Session 不一致' };
      }
      if (sent.deliveryProof.messageFingerprint && sent.deliveryProof.messageFingerprint !== hash(message)) {
        return { ok: false, delivered: false, code: 'DELIVERY_UNVERIFIED', reason: 'headless 送达证据的消息内容不一致' };
      }
      return { ok: true, delivered: true, verified: true, source: sent.deliveryProof.source, messageFingerprint: hash(message) };
    },
  };
  return {
    supported: true,
    source: agentId === 'claude' ? 'claude-stream-json-headless' : 'workbuddy-cli-headless',
    capabilities: {
      sessionActivator: async (target) => {
        const error = headlessTargetError(agentId, target);
        return error ? { ok: false, code: 'SESSION_IDENTITY_UNVERIFIED', reason: error }
          : { ok: true, action: 'headless-ready', source: 'headless-cli' };
      },
      identityVerifier,
      messageWriter: writer,
      deliveryVerifier,
    },
  };
}

module.exports = {
  HEADLESS_PROFILES, buildHeadlessInvocation, resolveWorkBuddyCliPath, HeadlessTransport,
  createHeadlessCapabilityBinding,
};
