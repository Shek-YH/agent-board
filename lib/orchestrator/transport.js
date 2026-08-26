'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

// 只保留经过明确适配的 headless CLI。模型输出不能改变 command 或 args 的结构。
const HEADLESS_PROFILES = {
  claude: {
    command: 'claude',
    args: ({ prompt }) => ['-p', prompt, '--output-format', 'stream-json'],
  },
  codex: {
    command: 'codex',
    args: ({ prompt }) => ['exec', '--json', prompt],
  },
};
const KNOWN_AGENTS = new Set(['claude', 'codex', 'workbuddy', 'deepseek', 'pi', 'hermes', 'zcode']);

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

function buildHeadlessInvocation({ agent, projectPath, prompt, workbuddyCliPath, nodeExecutable = process.execPath }) {
  const agentId = String(agent || '');
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
  const cwd = path.resolve(String(projectPath || ''));
  if (agentId === 'workbuddy') {
    const cliPath = String(workbuddyCliPath || '').trim();
    if (!cliPath) throw new Error('headless profile is not configured');
    return {
      command: nodeExecutable,
      args: [cliPath, '--print', '--output-format', 'json', '--max-turns', '3', '--permission-mode', 'auto', text],
      cwd,
      options: { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    };
  }
  return {
    command: profile.command,
    args: profile.args({ prompt: text }),
    cwd,
    options: { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  };
}

class HeadlessTransport {
  constructor({ enabled = false, spawnImpl = spawn, workbuddyCliPath = '', nodeExecutable = process.execPath } = {}) {
    this.enabled = Boolean(enabled);
    this.spawnImpl = spawnImpl;
    this.workbuddyCliPath = workbuddyCliPath;
    this.nodeExecutable = nodeExecutable;
  }

  run({ agent, projectPath, prompt }) {
    if (!this.enabled) {
      return Promise.resolve({ status: 'waiting_user', reason: 'headless execution is disabled' });
    }
    const invocation = buildHeadlessInvocation({
      agent, projectPath, prompt, workbuddyCliPath: this.workbuddyCliPath, nodeExecutable: this.nodeExecutable,
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

module.exports = { HEADLESS_PROFILES, buildHeadlessInvocation, resolveWorkBuddyCliPath, HeadlessTransport };
