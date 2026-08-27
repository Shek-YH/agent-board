'use strict';

const { spawnSync } = require('node:child_process');

// 只保留 Agent Board 当前支持的 Agent。AI 只能在这些固定定义里选择动作，
// 不能返回或执行任意命令。安装定义参考 EchoBird 的 docs/api/tools/install。
const AGENT_INSTALL_DEFINITIONS = Object.freeze({
  claude: {
    name: 'Claude Code', kind: 'cli', officialUrl: 'https://code.claude.com/docs/en/installation',
    command: { program: 'npm', args: ['install', '-g', '@anthropic-ai/claude-code'] },
  },
  codex: {
    name: 'Codex', kind: 'cli', officialUrl: 'https://github.com/openai/codex',
    command: { program: 'npm', args: ['install', '-g', '@openai/codex'] },
  },
  workbuddy: { name: 'WorkBuddy', kind: 'desktop', officialUrl: 'https://www.workbuddy.cn/work/#download-section' },
  deepseek: {
    name: 'DeepSeek Harness', kind: 'cli', officialUrl: 'https://www.deepseek.com/harness/en/',
    command: { program: 'npm', args: ['install', '-g', '@deepseek-ai/dsh'] },
  },
  marvis: { name: 'Marvis', kind: 'desktop', officialUrl: 'https://marvis.qq.com/' },
  zcode: { name: 'ZCode', kind: 'desktop', officialUrl: 'https://zcode.z.ai/cn#all-downloads' },
  pi: {
    name: 'Pi Agent', kind: 'cli', officialUrl: 'https://pi.dev/docs',
    command: { program: 'npm', args: ['install', '-g', '--ignore-scripts', '@earendil-works/pi-coding-agent'] },
  },
  hermes: { name: 'Hermes Agent', kind: 'desktop', officialUrl: 'https://hermes-agent.nousresearch.com/desktop' },
  aider: { name: 'Aider', kind: 'cli', officialUrl: 'https://aider.chat/docs/install.html' },
  claudescience: { name: 'Claude Science', kind: 'desktop', officialUrl: 'https://claude.com/product/claude-science' },
  coffeecli: { name: 'Coffee CLI', kind: 'cli', officialUrl: 'https://coffeecli.com/' },
  cursor: { name: 'Cursor', kind: 'desktop', officialUrl: 'https://cursor.com/' },
  geminidesktop: { name: 'Gemini 桌面端', kind: 'desktop', officialUrl: 'https://gemini.google/mac/' },
  grok: { name: 'Grok Build', kind: 'cli', officialUrl: 'https://docs.x.ai/build/overview' },
  kilo: { name: 'Kilo Code', kind: 'cli', officialUrl: 'https://kilo.ai/docs/cli' },
  kimicode: { name: 'Kimi Code', kind: 'cli', officialUrl: 'https://moonshotai.github.io/kimi-code/' },
  mimocode: { name: 'MiMo Code', kind: 'cli', officialUrl: 'https://mimo.xiaomi.com/mimocode/start' },
  openclaw: { name: 'OpenClaw', kind: 'cli', officialUrl: 'https://docs.openclaw.ai' },
  opencode: { name: 'OpenCode', kind: 'cli', officialUrl: 'https://opencode.ai/docs#install' },
  opencodedesktop: { name: 'OpenCode 桌面端', kind: 'desktop', officialUrl: 'https://opencode.ai/download' },
  openscience: { name: 'OpenScience', kind: 'cli', officialUrl: 'https://www.openscience.sh/docs' },
  qwencode: { name: 'QwenCode', kind: 'cli', officialUrl: 'https://qwenlm.github.io/qwen-code-docs/en/users/overview' },
  trae: { name: 'Trae', kind: 'desktop', officialUrl: 'https://www.trae.ai/' },
  traecn: { name: 'Trae CN', kind: 'desktop', officialUrl: 'https://www.trae.cn/' },
});

const INSTALL_ACTIONS = new Set(['install', 'open_download']);
const PROVIDERS = new Set(['openai', 'anthropic']);

function getAgentInstallDefinitions() {
  return AGENT_INSTALL_DEFINITIONS;
}

function nonBlank(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function validateInstallerRequest(input = {}) {
  const agentId = nonBlank(input.agentId);
  const apiKey = nonBlank(input.apiKey);
  const provider = nonBlank(input.provider).toLowerCase() || 'openai';
  const model = nonBlank(input.model);
  const baseUrl = nonBlank(input.baseUrl);
  if (!AGENT_INSTALL_DEFINITIONS[agentId]) throw new Error('未知 Agent，无法生成安装方案');
  if (!apiKey || apiKey.length > 4096) throw new Error('请输入有效的 AI 安装 API Key');
  if (!PROVIDERS.has(provider)) throw new Error('不支持的 AI 服务商');
  if (!model || model.length > 200) throw new Error('请输入有效的 AI 模型名');
  if (baseUrl) {
    let parsed;
    try { parsed = new URL(baseUrl); } catch { throw new Error('AI 接口地址不是有效 URL'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error('AI 接口地址只支持 http/https');
    }
  }
  return { agentId, apiKey, provider, model, baseUrl };
}

function endpointFor(provider, baseUrl) {
  const fallback = provider === 'anthropic'
    ? 'https://api.anthropic.com/v1/messages'
    : 'https://api.openai.com/v1/chat/completions';
  if (!baseUrl) return fallback;
  const url = new URL(baseUrl);
  const suffix = provider === 'anthropic' ? '/v1/messages' : '/chat/completions';
  const pathname = url.pathname.replace(/\/+$/, '');
  if (pathname.endsWith(suffix)) {
    url.pathname = pathname;
  } else if (pathname.endsWith('/v1')) {
    url.pathname = pathname + (provider === 'anthropic' ? '/messages' : '/chat/completions');
  } else {
    url.pathname = pathname + suffix;
  }
  return url.toString();
}

function buildInstallerPrompt({ agentId, platform }) {
  const def = AGENT_INSTALL_DEFINITIONS[agentId];
  if (!def) throw new Error('未知 Agent，无法生成安装提示');
  const action = def.command ? 'install' : 'open_download';
  return [
    '你是 Agent Board 的安装规划器。只返回一个 JSON 对象，不要 Markdown，不要命令，不要额外文字。',
    `目标 Agent：${agentId}（${def.name}），操作系统：${platform || process.platform}。`,
    `该 Agent 的安全动作只能是：${action}。`,
    'JSON 格式必须是：{"agentId":"目标 id","action":"install 或 open_download","reason":"不超过 160 字的中文说明"}。',
    '不得添加 command、script、args、url 等字段；不得修改目标 Agent；不得提出其他安装方式。',
  ].join('\n');
}

function extractPlanText(payload, provider) {
  if (provider === 'anthropic') {
    return (payload && Array.isArray(payload.content) ? payload.content : [])
      .filter((item) => item && item.type === 'text')
      .map((item) => item.text || '')
      .join('\n');
  }
  const content = payload && payload.choices && payload.choices[0] && payload.choices[0].message
    ? payload.choices[0].message.content
    : '';
  return Array.isArray(content) ? content.map((item) => item?.text || '').join('\n') : String(content || '');
}

function parseInstallerPlan(content, agentId) {
  const raw = String(content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error('AI 返回的安装方案不是有效 JSON'); }
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('AI 返回的安装方案格式无效');
  if (Object.keys(value).some((key) => !['agentId', 'action', 'reason'].includes(key))) {
    throw new Error('AI 安装方案包含未允许的字段');
  }
  if (value.agentId !== agentId || !INSTALL_ACTIONS.has(value.action)) {
    throw new Error('AI 安装方案未通过安全校验');
  }
  const def = AGENT_INSTALL_DEFINITIONS[agentId];
  if (value.action === 'install' && !def.command) {
    throw new Error('该桌面 Agent 只能打开官方下载页，不能静默安装');
  }
  return {
    agentId,
    action: value.action,
    reason: nonBlank(value.reason).slice(0, 160) || (value.action === 'install' ? '执行固定的官方 CLI 安装包' : '打开官方安装页面，由用户完成安装向导'),
  };
}

async function requestInstallerPlan(input, options = {}) {
  const config = validateInstallerRequest(input);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('当前运行环境不支持 AI 安装请求');
  const prompt = buildInstallerPrompt({ agentId: config.agentId, platform: options.platform || process.platform });
  const endpoint = endpointFor(config.provider, config.baseUrl);
  const headers = { 'Content-Type': 'application/json' };
  let body;
  if (config.provider === 'anthropic') {
    headers['x-api-key'] = config.apiKey;
    headers['anthropic-version'] = '2023-06-01';
    body = JSON.stringify({ model: config.model, max_tokens: 300, system: prompt, messages: [{ role: 'user', content: '请生成安装方案。' }] });
  } else {
    headers.Authorization = `Bearer ${config.apiKey}`;
    body = JSON.stringify({ model: config.model, temperature: 0, messages: [{ role: 'system', content: prompt }, { role: 'user', content: '请生成安装方案。' }] });
  }
  let response;
  try {
    response = await fetchImpl(endpoint, { method: 'POST', headers, body });
  } catch {
    throw new Error('AI 安装规划请求失败，请检查接口地址和网络');
  }
  if (!response || !response.ok) throw new Error(`AI 安装规划请求失败（HTTP ${response?.status || 0}）`);
  let payload;
  try { payload = await response.json(); } catch { throw new Error('AI 安装服务返回格式无效'); }
  return {
    plan: parseInstallerPlan(extractPlanText(payload, config.provider), config.agentId),
    endpoint,
  };
}

function runFixedInstallCommand(command, platform = process.platform) {
  const program = platform === 'win32' && command.program === 'npm' ? 'npm.cmd' : command.program;
  return spawnSync(program, command.args, {
    encoding: 'utf8', windowsHide: true, timeout: 10 * 60 * 1000, maxBuffer: 16 * 1024 * 1024,
  });
}

async function runAgentInstall(input, options = {}) {
  const { plan } = await requestInstallerPlan(input, options);
  const def = AGENT_INSTALL_DEFINITIONS[plan.agentId];
  if (plan.action === 'open_download') {
    return { ok: true, agentId: plan.agentId, action: plan.action, reason: plan.reason, downloadUrl: def.officialUrl };
  }
  const runCommand = options.runCommand || runFixedInstallCommand;
  const result = await Promise.resolve(runCommand(def.command, options.platform || process.platform));
  if (!result || result.error || (result.status !== 0 && result.code !== 0)) {
    throw new Error(`${def.name} 安装命令执行失败，请检查 Node/npm 和网络后重试`);
  }
  return { ok: true, agentId: plan.agentId, action: plan.action, reason: plan.reason };
}

module.exports = {
  AGENT_INSTALL_DEFINITIONS,
  buildInstallerPrompt,
  endpointFor,
  getAgentInstallDefinitions,
  parseInstallerPlan,
  requestInstallerPlan,
  runAgentInstall,
  validateInstallerRequest,
};
