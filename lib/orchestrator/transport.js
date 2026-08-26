'use strict';

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

function buildHeadlessInvocation({ agent, projectPath, prompt }) {
  const profile = HEADLESS_PROFILES[String(agent || '')];
  if (!profile) {
    if (!KNOWN_AGENTS.has(String(agent || ''))) throw new Error('unsupported agent for headless execution');
    throw new Error('headless profile is not configured');
  }
  const text = String(prompt || '').trim();
  if (!text) throw new Error('execution prompt is required');
  if (text.length > 200_000) throw new Error('execution prompt is too large');
  const cwd = path.resolve(String(projectPath || ''));
  return {
    command: profile.command,
    args: profile.args({ prompt: text }),
    cwd,
    options: { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  };
}

class HeadlessTransport {
  constructor({ enabled = false, spawnImpl = spawn } = {}) {
    this.enabled = Boolean(enabled);
    this.spawnImpl = spawnImpl;
  }

  run({ agent, projectPath, prompt }) {
    if (!this.enabled) {
      return Promise.resolve({ status: 'waiting_user', reason: 'headless execution is disabled' });
    }
    const invocation = buildHeadlessInvocation({ agent, projectPath, prompt });
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

module.exports = { HEADLESS_PROFILES, buildHeadlessInvocation, HeadlessTransport };
