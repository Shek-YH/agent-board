'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { getProviderCapabilities } = require('./provider-config');

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

test('domestic provider priority is stable when multiple providers are configured', () => {
  const result = getProviderCapabilities({
    OPENAI_API_KEY: 'international', ARK_API_KEY: 'volcengine', DASHSCOPE_API_KEY: 'bailian',
  });
  assert.equal(result.supervisor_llm.provider, 'dashscope');
  assert.equal(result.video_generation.provider, 'dashscope');
});
