'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  getProviderCapabilities,
  getProviderConfigState,
  normalizeSupervisorConfig,
  normalizeWorkerRoutingConfig,
} = require('./provider-config');

test('provider capabilities expose the planned slots without exposing secrets', () => {
  const result = getProviderCapabilities({ DASHSCOPE_API_KEY: 'secret-value' });
  assert.equal(result.supervisor_llm.available, true);
  assert.equal(result.supervisor_llm.provider, 'dashscope');
  assert.equal(result.stt_streaming.available, true);
  assert.equal(result.tts_streaming.available, true);
  assert.equal(result.voice_clone.available, true);
  assert.doesNotMatch(JSON.stringify(result), /secret-value/);
});

test('missing keys are reported as unavailable', () => {
  const result = getProviderCapabilities({});
  assert.equal(result.supervisor_llm.available, false);
  assert.equal(result.image_generation.available, false);
  assert.equal(result.voice_clone.available, false);
});

test('accepts ZHIPU_API_KEY as the shared alias for the ZAI provider', () => {
  const result = getProviderCapabilities({ ZHIPU_API_KEY: 'secret-value' });
  assert.equal(result.supervisor_llm.available, true);
  assert.equal(result.supervisor_llm.provider, 'zai');
  assert.equal(result.tts_streaming.provider, 'zai');
  assert.doesNotMatch(JSON.stringify(result), /secret-value/);
});

test('domestic provider priority is stable when multiple providers are configured', () => {
  const result = getProviderCapabilities({
    OPENAI_API_KEY: 'international', ARK_API_KEY: 'volcengine', DASHSCOPE_API_KEY: 'bailian',
  });
  assert.equal(result.supervisor_llm.provider, 'dashscope');
  assert.equal(result.video_generation.provider, 'dashscope');
});

test('normalizes supervisor model settings and drops secrets and command fields', () => {
  const result = normalizeSupervisorConfig({
    provider: ' OpenAI ', model: ' gpt-5.6 ', baseUrl: ' https://api.openai.com/v1/ ',
    temperature: '0.7', contextBudget: '128000', apiKey: 'secret-value', token: 'secret-token',
    commands: ['node unsafe.js'], transport: { run: 'unsafe' }, shell: 'do-not-run', extra: 'drop-me',
  });

  assert.deepEqual(result, {
    provider: 'openai', model: 'gpt-5.6', baseUrl: 'https://api.openai.com/v1',
    temperature: 0.7, contextBudget: 128000,
  });
  assert.doesNotMatch(JSON.stringify(result), /secret-value|secret-token|unsafe|drop-me/);
});

test('normalizes worker routing independently and never accepts supervisor fields', () => {
  const result = normalizeWorkerRoutingConfig({
    enabled: true, preset: 'custom', complexityTier: 'C2', thinkingTier: 'T2', promptPolicy: 'P2',
    provider: ' deepseek ', model: ' worker-model ', baseUrl: 'https://api.deepseek.com/v1',
    temperature: 0.2, contextBudget: 64000,
    supervisor: { provider: 'anthropic', model: 'supervisor-model' }, supervisorConfig: { token: 'drop-me' },
    apiKey: 'secret-value', token: 'secret-token', commands: ['rm -rf /'], unknown: true,
  });

  assert.equal(result.enabled, true);
  assert.equal(result.complexityTier, 'C2');
  assert.equal(result.provider, 'deepseek');
  assert.equal(result.model, 'worker-model');
  assert.equal(result.contextBudget, 64000);
  assert.equal('supervisor' in result, false);
  assert.equal('supervisorConfig' in result, false);
  assert.equal('apiKey' in result, false);
  assert.equal('token' in result, false);
  assert.equal('commands' in result, false);
});

test('provider config state is read-only and reports configured supervisor readiness without secrets', () => {
  const state = getProviderConfigState({
    env: {
      AGENT_BOARD_SUPERVISOR_PROVIDER: 'openai',
      AGENT_BOARD_SUPERVISOR_MODEL: 'gpt-5.6',
      AGENT_BOARD_SUPERVISOR_BASE_URL: 'https://api.openai.com/v1',
      AGENT_BOARD_SUPERVISOR_TEMPERATURE: '0.4',
      AGENT_BOARD_SUPERVISOR_CONTEXT_BUDGET: '128000',
      OPENAI_API_KEY: 'secret-value',
    },
    supervisorConfig: { apiKey: 'another-secret', token: 'another-token' },
    workerRoutingConfig: { enabled: true, provider: 'codex', model: 'gpt-5.6-sol' },
  });

  assert.equal(state.readOnly, true);
  assert.equal(state.supervisor.provider, 'openai');
  assert.equal(state.supervisor.model, 'gpt-5.6');
  assert.equal(state.supervisor.temperature, 0.4);
  assert.equal(state.supervisor.contextBudget, 128000);
  assert.equal(state.supervisor.available, true);
  assert.equal(state.supervisor.configured, true);
  assert.equal(state.supervisor.reasonCode, 'SUPERVISOR_READY');
  assert.equal(state.workerRouting.model, 'gpt-5.6-sol');
  assert.equal(state.workerRouting.available, true);
  assert.equal(state.workerRouting.blocking, false);
  assert.doesNotMatch(JSON.stringify(state), /secret-value|another-secret|another-token/);
});

test('unconfigured provider state is explicit and does not block base AutoPilot', () => {
  const state = getProviderConfigState({ env: {} });

  assert.equal(state.supervisor.available, false);
  assert.equal(state.supervisor.configured, false);
  assert.equal(state.supervisor.reasonCode, 'SUPERVISOR_UNCONFIGURED');
  assert.equal(state.supervisor.blocking, false);
  assert.equal(state.workerRouting.available, false);
  assert.equal(state.workerRouting.reasonCode, 'WORKER_ROUTING_DISABLED');
  assert.equal(state.baseAutoPilot.available, true);
  assert.equal(state.baseAutoPilot.blocking, false);
  assert.equal(state.baseAutoPilot.reasonCode, 'BASE_AUTOPILOT_AVAILABLE');
});
