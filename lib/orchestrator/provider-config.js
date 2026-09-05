'use strict';

const { normalizeRoutingConfig } = require('./routing/runtime');

const SLOTS = {
  // 国内供应商优先；保留国际供应商作为后续可选 fallback，不改变槽位接口。
  supervisor_llm: ['DASHSCOPE_API_KEY', 'ZAI_API_KEY', 'ARK_API_KEY', 'MINIMAX_API_KEY', 'DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'OPENAI_COMPATIBLE_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY'],
  stt_streaming: ['DASHSCOPE_API_KEY', 'ZAI_API_KEY', 'ARK_API_KEY', 'OPENAI_API_KEY', 'DEEPGRAM_API_KEY', 'GEMINI_API_KEY'],
  stt_batch: ['DASHSCOPE_API_KEY', 'ZAI_API_KEY', 'ARK_API_KEY', 'OPENAI_API_KEY', 'DEEPGRAM_API_KEY', 'GEMINI_API_KEY'],
  tts_streaming: ['DASHSCOPE_API_KEY', 'ZAI_API_KEY', 'ARK_API_KEY', 'MINIMAX_API_KEY', 'OPENAI_API_KEY', 'ELEVENLABS_API_KEY', 'GEMINI_API_KEY'],
  tts_batch: ['DASHSCOPE_API_KEY', 'ZAI_API_KEY', 'ARK_API_KEY', 'MINIMAX_API_KEY', 'OPENAI_API_KEY', 'ELEVENLABS_API_KEY', 'GEMINI_API_KEY'],
  voice_clone: ['DASHSCOPE_API_KEY', 'MINIMAX_API_KEY', 'ZAI_API_KEY', 'ARK_API_KEY', 'ELEVENLABS_API_KEY'],
  vision: ['DASHSCOPE_API_KEY', 'ZAI_API_KEY', 'ARK_API_KEY', 'MINIMAX_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY'],
  image_generation: ['DASHSCOPE_API_KEY', 'ARK_API_KEY', 'MINIMAX_API_KEY', 'ZAI_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY'],
  video_generation: ['DASHSCOPE_API_KEY', 'ARK_API_KEY', 'ZAI_API_KEY', 'MINIMAX_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY'],
  embeddings: ['DASHSCOPE_API_KEY', 'ZAI_API_KEY', 'ARK_API_KEY', 'MINIMAX_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY'],
  moderation: ['DASHSCOPE_API_KEY', 'ZAI_API_KEY', 'ARK_API_KEY', 'OPENAI_API_KEY'],
};
const PROVIDER_LABELS = {
  dashscope: '阿里云百炼', zai: '智谱', ark: '火山方舟', minimax: 'MiniMax',
  openai: 'OpenAI', anthropic: 'Anthropic', gemini: 'Gemini', deepseek: 'DeepSeek', openrouter: 'OpenRouter',
  'openai-compatible': 'OpenAI-compatible', deepgram: 'Deepgram', elevenlabs: 'ElevenLabs',
};

const DEFAULT_MODEL_CONFIG = Object.freeze({
  provider: null,
  model: null,
  baseUrl: null,
  temperature: 0,
  contextBudget: null,
});

const SUPERVISOR_ENV_KEYS = Object.freeze({
  provider: ['AGENT_BOARD_SUPERVISOR_PROVIDER', 'AUTOPILOT_SUPERVISOR_PROVIDER', 'SUPERVISOR_PROVIDER'],
  model: ['AGENT_BOARD_SUPERVISOR_MODEL', 'AUTOPILOT_SUPERVISOR_MODEL', 'JARVIS_SUPERVISOR_MODEL', 'SUPERVISOR_MODEL', 'model', 'MODEL'],
  baseUrl: ['AGENT_BOARD_SUPERVISOR_BASE_URL', 'AUTOPILOT_SUPERVISOR_BASE_URL', 'SUPERVISOR_BASE_URL'],
  temperature: ['AGENT_BOARD_SUPERVISOR_TEMPERATURE', 'AUTOPILOT_SUPERVISOR_TEMPERATURE', 'SUPERVISOR_TEMPERATURE'],
  contextBudget: ['AGENT_BOARD_SUPERVISOR_CONTEXT_BUDGET', 'AUTOPILOT_SUPERVISOR_CONTEXT_BUDGET', 'SUPERVISOR_CONTEXT_BUDGET'],
});

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function safeText(value, maxLength) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) return null;
  return normalized;
}

function normalizeProvider(value) {
  const normalized = safeText(value, 64);
  if (!normalized) return null;
  const provider = normalized.toLowerCase().replace(/_/g, '-');
  return /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(provider) ? provider : null;
}

function normalizeModel(value) {
  return safeText(value, 200);
}

function normalizeBaseUrl(value) {
  const normalized = safeText(value, 2_048);
  if (!normalized) return null;
  try {
    const url = new URL(normalized);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) {
      return null;
    }
    return url.href.replace(/\/+$/, '') || null;
  } catch {
    return null;
  }
}

function numberValue(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim()) return Number(value.trim());
  return null;
}

function normalizeTemperature(value) {
  const number = numberValue(value);
  return Number.isFinite(number) && number >= 0 && number <= 2 ? number : DEFAULT_MODEL_CONFIG.temperature;
}

function normalizeContextBudget(value) {
  const number = numberValue(value);
  return Number.isInteger(number) && number >= 1 && number <= 10_000_000 ? number : DEFAULT_MODEL_CONFIG.contextBudget;
}

function normalizeSupervisorConfig(config = {}) {
  const input = asObject(config);
  return {
    provider: normalizeProvider(input.provider),
    model: normalizeModel(input.model),
    baseUrl: normalizeBaseUrl(input.baseUrl),
    temperature: normalizeTemperature(input.temperature),
    contextBudget: normalizeContextBudget(input.contextBudget),
  };
}

function normalizeWorkerRoutingConfig(config = {}) {
  const input = asObject(config);
  const nestedConfig = asObject(input.providerConfig);
  const modelConfig = ['provider', 'model', 'baseUrl', 'temperature', 'contextBudget']
    .some((field) => Object.prototype.hasOwnProperty.call(nestedConfig, field)) ? nestedConfig : input;
  return { ...normalizeRoutingConfig(input), ...normalizeSupervisorConfig(modelConfig) };
}

function firstEnvValue(env, names) {
  for (const name of names) {
    if (env[name] !== undefined && env[name] !== null && String(env[name]).trim()) return env[name];
  }
  return undefined;
}

function providerKeyNames(provider) {
  const normalized = String(provider || '').toUpperCase().replace(/-/g, '_').replace(/\./g, '_');
  const aliases = normalized === 'ZAI' ? ['ZAI_API_KEY', 'ZHIPU_API_KEY'] : normalized ? [`${normalized}_API_KEY`] : [];
  return [...aliases, 'AGENT_BOARD_SUPERVISOR_API_KEY'];
}

function providerForKey(key) {
  return key === 'ZHIPU_API_KEY' ? 'zai' : key.replace(/_API_KEY$/, '').toLowerCase();
}

function slotKeys(keys) {
  return keys.flatMap((key) => key === 'ZAI_API_KEY' ? [key, 'ZHIPU_API_KEY'] : [key]);
}

function getProviderConfigState({ env = process.env, supervisorConfig = {}, workerRoutingConfig = {} } = {}) {
  const source = asObject(env);
  const suppliedSupervisor = asObject(supervisorConfig);
  const rawSupervisor = {};
  for (const field of Object.keys(SUPERVISOR_ENV_KEYS)) {
    rawSupervisor[field] = Object.prototype.hasOwnProperty.call(suppliedSupervisor, field)
      ? suppliedSupervisor[field] : firstEnvValue(source, SUPERVISOR_ENV_KEYS[field]);
  }
  const normalizedSupervisor = normalizeSupervisorConfig(rawSupervisor);
  const capabilities = getProviderCapabilities(source);
  const capability = capabilities.supervisor_llm || {};
  const provider = normalizedSupervisor.provider || capability.provider || null;
  const credentialConfigured = providerKeyNames(provider).some((name) => String(source[name] || '').trim())
    || (!normalizedSupervisor.provider && capability.available === true);
  const supervisorConfigured = credentialConfigured
    || Boolean(provider || normalizedSupervisor.model || normalizedSupervisor.baseUrl
      || normalizedSupervisor.contextBudget !== null || normalizedSupervisor.temperature !== DEFAULT_MODEL_CONFIG.temperature);
  const supervisor = {
    role: 'supervisor',
    ...normalizedSupervisor,
    provider,
    providerName: provider ? (PROVIDER_LABELS[provider] || provider) : null,
    available: credentialConfigured,
    configured: supervisorConfigured,
    credentialConfigured,
    blocking: false,
    reasonCode: credentialConfigured
      ? 'SUPERVISOR_READY'
      : supervisorConfigured ? 'SUPERVISOR_CREDENTIAL_MISSING' : 'SUPERVISOR_UNCONFIGURED',
  };
  const workerRouting = normalizeWorkerRoutingConfig(workerRoutingConfig);
  const workerEnabled = workerRouting.enabled === true;
  return {
    readOnly: true,
    supervisor,
    workerRouting: {
      role: 'worker',
      ...workerRouting,
      available: workerEnabled,
      configured: workerEnabled,
      blocking: false,
      reasonCode: workerEnabled ? 'WORKER_ROUTING_CONFIGURED' : 'WORKER_ROUTING_DISABLED',
    },
    baseAutoPilot: {
      available: true,
      blocking: false,
      reasonCode: 'BASE_AUTOPILOT_AVAILABLE',
    },
  };
}

function getProviderCapabilities(env = process.env) {
  const source = asObject(env);
  const result = {};
  for (const [slot, keys] of Object.entries(SLOTS)) {
    const key = slotKeys(keys).find((name) => String(source[name] || '').trim());
    const provider = key ? providerForKey(key) : null;
    result[slot] = { available: Boolean(key), provider, providerName: provider ? (PROVIDER_LABELS[provider] || provider) : null };
  }
  return result;
}

module.exports = {
  DEFAULT_MODEL_CONFIG,
  PROVIDER_LABELS,
  SLOTS,
  getProviderCapabilities,
  getProviderConfigState,
  normalizeSupervisorConfig,
  normalizeWorkerRoutingConfig,
};
