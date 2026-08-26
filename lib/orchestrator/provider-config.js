'use strict';

const SLOTS = {
  // 国内供应商优先；保留国际供应商作为后续可选 fallback，不改变槽位接口。
  supervisor_llm: ['DASHSCOPE_API_KEY', 'ZAI_API_KEY', 'ARK_API_KEY', 'MINIMAX_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY'],
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
  openai: 'OpenAI', anthropic: 'Anthropic', gemini: 'Gemini', deepgram: 'Deepgram', elevenlabs: 'ElevenLabs',
};

function getProviderCapabilities(env = process.env) {
  const result = {};
  for (const [slot, keys] of Object.entries(SLOTS)) {
    const key = keys.find((name) => String(env[name] || '').trim());
    const provider = key ? key.replace(/_API_KEY$/, '').toLowerCase() : null;
    result[slot] = { available: Boolean(key), provider, providerName: provider ? (PROVIDER_LABELS[provider] || provider) : null };
  }
  return result;
}

module.exports = { SLOTS, PROVIDER_LABELS, getProviderCapabilities };
