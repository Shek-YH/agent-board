'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_MAX_BYTES = 200_000;
const DEFAULT_MAX_FILES = 12;
const PROVIDER_KEY_ORDER = Object.freeze([
  ['dashscope', 'DASHSCOPE_API_KEY'], ['zai', 'ZAI_API_KEY'], ['ark', 'ARK_API_KEY'],
  ['minimax', 'MINIMAX_API_KEY'], ['deepseek', 'DEEPSEEK_API_KEY'], ['openai', 'OPENAI_API_KEY'],
  ['openai-compatible', 'OPENAI_COMPATIBLE_API_KEY'], ['anthropic', 'ANTHROPIC_API_KEY'],
  ['gemini', 'GEMINI_API_KEY'], ['openrouter', 'OPENROUTER_API_KEY'],
]);
const DEFAULT_ENDPOINTS = Object.freeze({
  dashscope: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
  zai: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
  ark: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
  minimax: 'https://api.minimaxi.com/v1/text/chatcompletion_v2',
  deepseek: 'https://api.deepseek.com/chat/completions',
  openai: 'https://api.openai.com/v1/chat/completions',
  'openai-compatible': 'https://api.openai.com/v1/chat/completions',
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
  anthropic: 'https://api.anthropic.com/v1/messages',
});
const DEFAULT_MODELS = Object.freeze({
  dashscope: 'qwen-plus', zai: 'glm-4.7-flash', ark: 'default',
  minimax: 'MiniMax-Text-01', deepseek: 'deepseek-chat', openai: 'gpt-4o-mini',
  anthropic: 'claude-3-5-haiku-latest', openrouter: 'openai/gpt-4o-mini',
  'openai-compatible': 'default',
});

function prdError(code, message, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function text(value, maxLength = 500) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, maxLength) : '';
}

function candidateFiles(projectPath, maxFiles = DEFAULT_MAX_FILES) {
  const root = path.resolve(String(projectPath || '').trim());
  let stat;
  try { stat = fs.statSync(root); } catch (error) {
    if (error.code === 'ENOENT') throw prdError('PROJECT_PRD_PROJECT_NOT_FOUND', '当前项目不存在', 404);
    throw prdError('PROJECT_PRD_PROJECT_UNREADABLE', '当前项目无法读取', 422);
  }
  if (!stat.isDirectory()) throw prdError('PROJECT_PRD_PROJECT_INVALID', '当前 Session 绑定的路径不是项目目录', 422);

  const files = [];
  const addEntries = (directory, priority) => {
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !/\.md$/i.test(entry.name) || !/prd/i.test(entry.name)) continue;
      const fullPath = path.join(directory, entry.name);
      const exact = entry.name.toLowerCase() === 'prd.md';
      files.push({ path: fullPath, priority: exact ? 0 : priority, name: entry.name });
    }
  };
  addEntries(root, 1);
  const docs = path.join(root, 'docs');
  try { if (fs.statSync(docs).isDirectory()) addEntries(docs, 2); } catch { /* docs is optional. */ }
  return files.sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name)).slice(0, maxFiles);
}

function findProjectPrd(projectPath, { maxBytes = DEFAULT_MAX_BYTES, maxFiles = DEFAULT_MAX_FILES } = {}) {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new RangeError('maxBytes must be a positive integer');
  const candidates = candidateFiles(projectPath, maxFiles);
  if (!candidates.length) throw prdError('PROJECT_PRD_NOT_FOUND', '当前项目内未找到 PRD.md 或其它 PRD Markdown 文件', 404);
  let oversized = false;
  for (const candidate of candidates) {
    let stat;
    try { stat = fs.statSync(candidate.path); } catch { continue; }
    if (stat.size > maxBytes) { oversized = true; continue; }
    try {
      const content = fs.readFileSync(candidate.path, 'utf8');
      return {
        filePath: candidate.path,
        relativePath: path.relative(path.resolve(projectPath), candidate.path).split(path.sep).join('/'),
        bytes: Buffer.byteLength(content, 'utf8'),
        content,
      };
    } catch { /* Try the next bounded candidate. */ }
  }
  throw prdError(oversized ? 'PROJECT_PRD_TOO_LARGE' : 'PROJECT_PRD_UNREADABLE', oversized ? 'PRD 文件超过读取上限' : 'PRD 文件无法读取', 422);
}

function extractPrdSignals(content) {
  const lines = String(content || '').replace(/\r\n?/g, '\n').split('\n');
  const headings = [];
  const bullets = [];
  let section = '';
  for (const line of lines) {
    const heading = line.match(/^\s{0,3}#{1,3}\s+(.+?)\s*#*\s*$/);
    if (heading) {
      section = text(heading[1], 160);
      headings.push(section);
      continue;
    }
    const bullet = line.match(/^\s*(?:[-*+] |\d+[.)] )(.+)$/);
    if (bullet && /(验收|accept|dod|完成|验证|测试|标准)/i.test(section)) bullets.push(text(bullet[1], 220));
  }
  const paragraph = lines
    .map((line) => text(line, 260))
    .find((line) => line && !/^[-*+] /.test(line) && !/^\d+[.)] /.test(line) && !/^#/.test(line));
  const title = headings[0] || '';
  const goal = title && paragraph
    ? `完成“${title}”：${paragraph}`
    : title ? `完成 PRD 中“${title}”定义的项目目标` : paragraph || '按当前项目 PRD 完成已定义目标';
  const dod = [...new Set(bullets.filter(Boolean))].slice(0, 8);
  if (!dod.length) dod.push('PRD 中定义的项目目标已完成并通过验证');
  return { goal: text(goal, 500), dod, scope: { inScope: headings.slice(0, 8), outOfScope: [] } };
}

function configuredModel(env = {}) {
  const source = env && typeof env === 'object' ? env : {};
  const explicitProvider = text(source.AGENT_BOARD_SUPERVISOR_PROVIDER, 64).toLowerCase().replace(/_/g, '-');
  const selected = PROVIDER_KEY_ORDER.find(([provider, key]) => String(source[key] || '').trim());
  const provider = explicitProvider || (selected && selected[0]) || '';
  const keyName = PROVIDER_KEY_ORDER.find(([item]) => item === provider)?.[1];
  const apiKey = String(source[keyName || ''] || source.AGENT_BOARD_SUPERVISOR_API_KEY || '').trim();
  if (!apiKey || !provider || !DEFAULT_ENDPOINTS[provider]) return null;
  const endpoint = text(source.AGENT_BOARD_SUPERVISOR_ENDPOINT, 2_048) || text(source.AGENT_BOARD_SUPERVISOR_BASE_URL, 2_048);
  let url = endpoint || DEFAULT_ENDPOINTS[provider];
  if (endpoint && !/\/chat\/completions$|\/messages$/i.test(endpoint)) {
    url = endpoint.replace(/\/+$/, '') + (provider === 'anthropic' ? '/messages' : '/chat/completions');
  }
  return {
    provider, apiKey, endpoint: url,
    model: text(source.AGENT_BOARD_SUPERVISOR_MODEL, 200) || DEFAULT_MODELS[provider] || 'gpt-4o-mini',
  };
}

function buildPrdPrompt() {
  return [
    '你是 Agent Board 的 PRD 目标助手。',
    '只根据用户提供的当前项目 PRD 生成草稿，不要执行任何操作，不要创建文件，不要输出命令。',
    '只返回 JSON：{"goal":"不超过500字的任务目标","dod":["1-8条可验证验收条件"],"scope":{"inScope":[],"outOfScope":[]}}。',
    'Goal 必须是可执行但不包含具体 shell 命令的目标；DoD 必须是可验证结果。',
  ].join('\n');
}

function extractModelText(payload, provider) {
  if (provider === 'anthropic') {
    return Array.isArray(payload?.content) ? payload.content.filter((item) => item?.type === 'text').map((item) => item.text || '').join('\n') : '';
  }
  const content = payload?.choices?.[0]?.message?.content;
  return Array.isArray(content) ? content.map((item) => item?.text || '').join('\n') : String(content || '');
}

function parseModelDraft(raw) {
  const cleaned = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  let value;
  try { value = JSON.parse(cleaned); } catch { throw new Error('PRD 助手返回的草稿不是有效 JSON'); }
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('PRD 助手返回的草稿格式无效');
  const goal = text(value.goal, 500);
  const dod = Array.isArray(value.dod) ? [...new Set(value.dod.map((item) => text(item, 220)).filter(Boolean))].slice(0, 8) : [];
  if (!goal || !dod.length) throw new Error('PRD 助手返回的草稿缺少 Goal 或 DoD');
  const scope = value.scope && typeof value.scope === 'object' && !Array.isArray(value.scope) ? value.scope : {};
  return {
    goal, dod,
    scope: {
      inScope: Array.isArray(scope.inScope) ? scope.inScope.map((item) => text(item, 160)).filter(Boolean).slice(0, 8) : [],
      outOfScope: Array.isArray(scope.outOfScope) ? scope.outOfScope.map((item) => text(item, 160)).filter(Boolean).slice(0, 8) : [],
    },
  };
}

async function requestModelDraft(model, content, fetchImpl) {
  const headers = { 'Content-Type': 'application/json' };
  let body;
  if (model.provider === 'anthropic') {
    headers['x-api-key'] = model.apiKey;
    headers['anthropic-version'] = '2023-06-01';
    body = JSON.stringify({ model: model.model, max_tokens: 900, temperature: 0, system: buildPrdPrompt(), messages: [{ role: 'user', content }] });
  } else {
    headers.Authorization = `Bearer ${model.apiKey}`;
    body = JSON.stringify({ model: model.model, temperature: 0, messages: [{ role: 'system', content: buildPrdPrompt() }, { role: 'user', content }] });
  }
  let response;
  try { response = await fetchImpl(model.endpoint, { method: 'POST', headers, body }); } catch { throw new Error('PRD 助手请求失败，请检查接口地址和网络'); }
  if (!response || !response.ok) throw new Error(`PRD 助手请求失败（HTTP ${response?.status || 0}）`);
  let payload;
  try { payload = typeof response.json === 'function' ? await response.json() : JSON.parse(await response.text()); } catch { throw new Error('PRD 助手返回格式无效'); }
  return parseModelDraft(extractModelText(payload, model.provider));
}

async function generatePrdGoalDraft({ projectPath, env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const prd = findProjectPrd(projectPath);
  const localDraft = extractPrdSignals(prd.content);
  const model = configuredModel(env);
  if (!model || typeof fetchImpl !== 'function') {
    return {
      source: 'local-extraction',
      warning: '未配置可用的 Supervisor API，已生成本地 PRD 草稿，请人工确认。',
      prd: { relativePath: prd.relativePath, bytes: prd.bytes },
      draft: localDraft,
    };
  }
  try {
    const draft = await requestModelDraft(model, prd.content, fetchImpl);
    return { source: 'model', prd: { relativePath: prd.relativePath, bytes: prd.bytes }, draft };
  } catch (error) {
    return {
      source: 'local-extraction',
      warning: `${error.message} 已退回本地 PRD 草稿，请人工确认。`,
      prd: { relativePath: prd.relativePath, bytes: prd.bytes },
      draft: localDraft,
    };
  }
}

module.exports = {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_FILES,
  buildPrdPrompt,
  extractPrdSignals,
  findProjectPrd,
  generatePrdGoalDraft,
  parseModelDraft,
};
