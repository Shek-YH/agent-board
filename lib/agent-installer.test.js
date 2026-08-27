'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildInstallerPrompt,
  getAgentInstallDefinitions,
  parseInstallerPlan,
  runAgentInstall,
  validateInstallerRequest,
} = require('./agent-installer');
const detectionCatalog = require('./agent-detection-catalog');

test('AI 安装规划只允许固定 Agent 动作，不接受模型返回的命令字段', () => {
  const prompt = buildInstallerPrompt({ agentId: 'codex', platform: 'win32' });
  assert.match(prompt, /只返回一个 JSON/);
  assert.match(prompt, /不得添加 command/);
  assert.throws(() => parseInstallerPlan('{"agentId":"codex","action":"install","command":"del *"}', 'codex'), /未允许的字段/);
  assert.throws(() => parseInstallerPlan('{"agentId":"codex","action":"run","reason":"x"}', 'codex'), /安全校验/);
});

test('AI 安装把 API Key 只放在请求头，执行固定 npm 安装定义', async () => {
  let request;
  let command;
  const result = await runAgentInstall({
    agentId: 'codex', provider: 'openai', model: 'test-model', apiKey: 'secret-key',
  }, {
    platform: 'linux',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"agentId":"codex","action":"install","reason":"安装 Codex"}' } }] }) };
    },
    runCommand: (spec) => { command = spec; return { status: 0 }; },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(command, { program: 'npm', args: ['install', '-g', '@openai/codex'] });
  assert.equal(request.options.headers.Authorization, 'Bearer secret-key');
  assert.equal(JSON.stringify(JSON.parse(request.options.body)).includes('secret-key'), false);
  assert.equal(JSON.stringify(result).includes('secret-key'), false);
});

test('桌面 Agent 的 AI 安装只返回官方下载页，不执行命令', async () => {
  let called = false;
  const result = await runAgentInstall({
    agentId: 'zcode', provider: 'openai', model: 'test-model', apiKey: 'secret-key',
  }, {
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"agentId":"zcode","action":"open_download","reason":"打开官方安装页"}' } }] }) }),
    runCommand: () => { called = true; return { status: 0 }; },
  });
  assert.equal(result.action, 'open_download');
  assert.equal(result.downloadUrl, 'https://zcode.z.ai/cn#all-downloads');
  assert.equal(called, false);
});

test('AI 安装请求校验 API Key 和 Agent 白名单', () => {
  assert.throws(() => validateInstallerRequest({ agentId: 'unknown', apiKey: 'x', model: 'm' }), /未知 Agent/);
  assert.throws(() => validateInstallerRequest({ agentId: 'codex', apiKey: '', model: 'm' }), /API Key/);
  assert.throws(() => validateInstallerRequest({ agentId: 'codex', apiKey: 'x', model: 'm', provider: 'shell' }), /服务商/);
});

test('应用管理探测目录中的 Agent 都有受控的 AI 安装入口', () => {
  const definitions = getAgentInstallDefinitions();
  for (const agent of detectionCatalog) assert.ok(definitions[agent.ID], `缺少 ${agent.ID} 的安装定义`);
  for (const definition of Object.values(definitions)) {
    assert.match(definition.officialUrl, /^https?:\/\//);
  }
});
