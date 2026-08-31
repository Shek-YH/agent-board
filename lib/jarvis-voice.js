'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { classifyProject } = require('./orchestrator/project-classifier');
const { assertAllowedProject, createWorkflowRequest } = require('./orchestrator/api');
const { getDataDir } = require('./runtime-paths');

const DEFAULTS = {
  asrEndpoint: 'https://open.bigmodel.cn/api/paas/v4/audio/transcriptions',
  asrModel: 'glm-asr-2512',
  supervisorEndpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
  supervisorModel: 'glm-4.7-flash',
  ttsEndpoint: 'https://open.bigmodel.cn/api/paas/v4/audio/speech',
  ttsModel: 'glm-tts',
  maxAudioBytes: 8 * 1024 * 1024,
};

const ALLOWED_AUDIO_TYPES = new Set([
  'audio/aac', 'audio/mp4', 'audio/mpeg', 'audio/ogg', 'audio/opus', 'audio/wav', 'audio/webm',
]);

function jsonError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function responseJson(response) {
  if (typeof response.json === 'function') return response.json();
  return response.text().then((text) => JSON.parse(text));
}

async function requestJson(fetchImpl, url, options, label) {
  const response = await fetchImpl(url, options);
  if (!response || !response.ok) {
    throw jsonError(`${label} 请求失败${response && response.status ? `（HTTP ${response.status}）` : ''}`, 502);
  }
  try {
    return await responseJson(response);
  } catch {
    throw jsonError(`${label} 返回格式无效`, 502);
  }
}

function cleanJsonText(value) {
  return String(value || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
}

function extractTranscript(payload) {
  const candidates = [
    payload && payload.text,
    payload && payload.transcript,
    payload && payload.data && payload.data.text,
    payload && payload.choices && payload.choices[0] && payload.choices[0].message && payload.choices[0].message.content,
  ];
  const text = candidates.find((item) => typeof item === 'string' && item.trim());
  if (!text) throw jsonError('语音识别没有返回文本', 502);
  return text.trim();
}

function parseWeatherIntent(text) {
  const source = String(text || '').trim();
  if (!source || !/(天气|气温|温度|下雨)/.test(source)) return null;
  const date = /明天/.test(source) ? 'tomorrow' : /后天/.test(source) ? 'day_after_tomorrow' : 'today';
  const withoutDate = source.replace(/今天|明天|后天/g, ' ');
  const match = withoutDate.match(/([\u4e00-\u9fff]{2,10}?)\s*(?:的)?(?:天气|气温|温度)/);
  if (!match) return null;
  return { action: 'weather_lookup', city: match[1], date, worker: 'workbuddy' };
}

function normalizeIntent(value, sourceText = '') {
  let intent = value;
  if (typeof intent === 'string') {
    try { intent = JSON.parse(cleanJsonText(intent)); } catch { intent = null; }
  }
  if (!intent || intent.action !== 'weather_lookup') return null;
  const city = String(intent.city || '').trim().replace(/[。！？!?，,]+$/g, '');
  const date = String(intent.date || '').trim();
  if (!city || !/^[\u4e00-\u9fffA-Za-z·\s-]{2,30}$/.test(city)) return null;
  if (!['today', 'tomorrow', 'day_after_tomorrow'].includes(date)) return null;
  return { action: 'weather_lookup', city, date, worker: 'workbuddy', sourceText: String(sourceText || '').trim() };
}

function parseSupervisorIntent(payload, sourceText) {
  const message = payload && payload.choices && payload.choices[0] && payload.choices[0].message;
  const content = message && message.content;
  return normalizeIntent(content, sourceText);
}

function dateLabel(date) {
  return date === 'tomorrow' ? '明天' : date === 'day_after_tomorrow' ? '后天' : '今天';
}

function buildWeatherPrompt(intent) {
  return [
    '这是一个只读天气查询任务。',
    `请使用你当前可用的联网信息查询${intent.city}${dateLabel(intent.date)}的天气。`,
    '只查询和汇总，不修改项目文件，不创建文件，不执行 shell 命令，不安装依赖。',
    '最终请用简洁中文给出：天气状况、最高/最低温度（如可得）、降雨概率或风力（如可得），并注明信息时间或来源（如可得）。',
  ].join('\n');
}

function parseWorkerOutput(value) {
  const raw = String(value || '').trim();
  if (!raw) return 'WorkBuddy 未返回可读结果。';
  try {
    const payload = JSON.parse(raw);
    const items = Array.isArray(payload) ? payload : [payload];
    const result = items.reverse().find((item) => item && item.type === 'result' && typeof item.result === 'string');
    if (result) return result.result.trim();
    const text = items.find((item) => item && typeof item.output_text === 'string');
    if (text) return text.output_text.trim();
  } catch { /* WorkBuddy 的 text fallback 直接使用原文。 */ }
  return raw;
}

function summarizeWorkerOutput(value, max = 700) {
  const text = parseWorkerOutput(value).replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max) + '…' : text;
}

function safeSessionId() {
  return `jarvis-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${crypto.randomUUID().slice(0, 8)}`;
}

function audioId() {
  return `jarvis-${crypto.randomUUID()}.wav`;
}

function toBuffer(audioBase64) {
  const raw = String(audioBase64 || '').trim().replace(/^data:[^;]+;base64,/, '');
  if (!raw || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) throw jsonError('录音数据格式无效');
  try { return Buffer.from(raw, 'base64'); } catch { throw jsonError('录音数据格式无效'); }
}

function writeText(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, content, 'utf8');
  fs.renameSync(tempPath, filePath);
}

function buildVoicePlan(request) {
  const { classification, plan } = request;
  return {
    ...plan,
    preflight: [],
    verification: [],
    requiresApproval: false,
    approvalReason: '',
    actions: {
      createDirectory: classification.kind === 'new' && classification.exists === false,
      initializeGit: false,
    },
  };
}

function createJarvisVoiceRuntime({
  orchestration,
  env = process.env,
  fetchImpl = globalThis.fetch,
  dataDir = getDataDir({ env }),
  now = () => Date.now(),
  randomId = safeSessionId,
  FormDataImpl = globalThis.FormData,
  BlobImpl = globalThis.Blob,
} = {}) {
  if (!orchestration || !orchestration.store || !orchestration.runner) throw new Error('orchestration runtime is required');
  const paths = { audioDir: path.join(dataDir, 'jarvis-audio') };
  const apiKey = () => String(env.ZAI_API_KEY || env.ZHIPU_API_KEY || '').trim();
  const config = () => ({
    asrModel: String(env.JARVIS_STT_MODEL || DEFAULTS.asrModel),
    supervisorModel: String(env.JARVIS_SUPERVISOR_MODEL || DEFAULTS.supervisorModel),
    ttsModel: String(env.JARVIS_TTS_MODEL || DEFAULTS.ttsModel),
  });

  function readiness() {
    const keyAvailable = Boolean(apiKey());
    const workbuddyAvailable = Boolean(orchestration.transport && orchestration.transport.workbuddyCliPath);
    return {
      enabled: env.AGENT_BOARD_HEADLESS_EXECUTION === '1',
      provider: 'zai',
      asr: { available: keyAvailable, model: config().asrModel },
      supervisor: { available: keyAvailable, model: config().supervisorModel },
      tts: { available: keyAvailable, model: config().ttsModel },
      workbuddy: { available: workbuddyAvailable },
      allowedRoots: orchestration.allowedRoots || [],
    };
  }

  async function transcribe(audio, mimeType) {
    if (!apiKey()) throw jsonError('尚未配置 ZAI_API_KEY / ZHIPU_API_KEY，无法进行语音识别', 503);
    if (typeof fetchImpl !== 'function' || typeof FormDataImpl !== 'function' || typeof BlobImpl !== 'function') {
      throw jsonError('当前运行环境不支持语音识别', 503);
    }
    const form = new FormDataImpl();
    form.append('model', config().asrModel);
    form.append('stream', 'false');
    form.append('file', new BlobImpl([audio], { type: mimeType }), 'jarvis-recording.webm');
    const payload = await requestJson(fetchImpl, DEFAULTS.asrEndpoint, {
      method: 'POST', headers: { Authorization: `Bearer ${apiKey()}` }, body: form,
    }, '语音识别');
    return extractTranscript(payload);
  }

  async function supervise(text) {
    const localIntent = parseWeatherIntent(text);
    if (!apiKey()) {
      if (localIntent) return normalizeIntent(localIntent, text);
      throw jsonError('尚未配置 ZAI_API_KEY / ZHIPU_API_KEY，无法进行 Jarvis 意图判断', 503);
    }
    const payload = await requestJson(fetchImpl, DEFAULTS.supervisorEndpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config().supervisorModel,
        temperature: 0,
        max_tokens: 200,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: '你是 Jarvis 的安全任务分类器。当前 MVP 只允许 weather_lookup。只能输出 JSON：{"action":"weather_lookup","city":"城市","date":"today|tomorrow|day_after_tomorrow"}。禁止输出 shell 命令、代码、URL 或任何其它 action。无法判断时输出 {"action":"unsupported"}。',
          },
          { role: 'user', content: text },
        ],
      }),
    }, 'Jarvis 判断');
    const intent = parseSupervisorIntent(payload, text);
    if (intent) return intent;
    if (localIntent) return normalizeIntent(localIntent, text);
    throw jsonError('当前 MVP 只支持“查询某地今天/明天/后天的天气”', 422);
  }

  async function synthesize(text) {
    if (!apiKey()) return null;
    const payload = await fetchImpl(DEFAULTS.ttsEndpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: config().ttsModel, input: text, voice: String(env.JARVIS_TTS_VOICE || 'tongtong'), response_format: 'wav' }),
    });
    if (!payload || !payload.ok) throw jsonError(`语音合成请求失败${payload && payload.status ? `（HTTP ${payload.status}）` : ''}`, 502);
    const audio = Buffer.from(await payload.arrayBuffer());
    if (!audio.length) throw jsonError('语音合成没有返回音频', 502);
    const fileName = audioId();
    fs.mkdirSync(paths.audioDir, { recursive: true });
    const filePath = path.join(paths.audioDir, fileName);
    fs.writeFileSync(filePath, audio);
    return { fileName, url: `/api/jarvis/audio/${encodeURIComponent(fileName)}`, mimeType: 'audio/wav' };
  }

  function detailPathFor(projectPath, sessionId) {
    return path.join(projectPath, '.agent-board', 'sessions', sessionId, 'session.md');
  }

  function writeSessionDetail({ projectPath, sessionId, receivedAt, audioType, transcript, intent, prompt, workerResult, summary, audio }) {
    const filePath = detailPathFor(projectPath, sessionId);
    const detail = [
      '# Jarvis Voice Session',
      '',
      `- session: ${sessionId}`,
      `- receivedAt: ${new Date(receivedAt).toISOString()}`,
      `- input: ${audioType}`,
      `- worker: WorkBuddy`,
      '',
      '## 原始转写',
      '',
      transcript,
      '',
      '## Jarvis 结构化意图',
      '',
      '```json',
      JSON.stringify(intent, null, 2),
      '```',
      '',
      '## WorkBuddy 执行提示词',
      '',
      '```text',
      prompt,
      '```',
      '',
      '## WorkBuddy 完整返回',
      '',
      '```text',
      String(workerResult || '').trim(),
      '```',
      '',
      '## 返回摘要',
      '',
      summary,
      '',
      `## 音频\n\n${audio ? audio.url : '未生成（请配置 TTS）'}`,
      '',
    ].join('\n');
    writeText(filePath, detail);
    return filePath;
  }

  function ensureProject(projectPath) {
    const classification = classifyProject(projectPath);
    if (classification.kind === 'invalid') throw jsonError(classification.error || '项目目录无效');
    assertAllowedProject(classification.canonicalPath, orchestration.allowedRoots || []);
    return classification.canonicalPath;
  }

  async function handleVoice({ audioBase64, mimeType = 'audio/webm', projectPath } = {}) {
    if (env.AGENT_BOARD_HEADLESS_EXECUTION !== '1') throw jsonError('headless 执行未开启，请先设置 AGENT_BOARD_HEADLESS_EXECUTION=1', 503);
    if (!orchestration.transport || !orchestration.transport.workbuddyCliPath) throw jsonError('未找到 WorkBuddy headless CLI', 503);
    const type = String(mimeType || '').toLowerCase().split(';')[0];
    if (!ALLOWED_AUDIO_TYPES.has(type)) throw jsonError('不支持的录音格式');
    const audio = toBuffer(audioBase64);
    if (!audio.length || audio.length > DEFAULTS.maxAudioBytes) throw jsonError('录音大小必须在 1B 到 8MB 之间');
    const canonicalProjectPath = ensureProject(projectPath || env.AGENT_BOARD_JARVIS_PROJECT_PATH);
    const receivedAt = now();
    const sessionId = randomId();
    const transcript = await transcribe(audio, type);
    const intent = await supervise(transcript);
    if (!intent || intent.worker !== 'workbuddy') throw jsonError('当前 MVP 只允许 WorkBuddy 天气查询', 422);
    const prompt = buildWeatherPrompt(intent);
    const request = createWorkflowRequest({
      projectPath: canonicalProjectPath, goal: prompt, mode: 'project', agent: 'workbuddy', requestedBy: 'jarvis-voice',
      verify: { dod: ['返回天气查询结果'], evidence: ['WorkBuddy workflow result'] },
      allowedRoots: orchestration.allowedRoots || [], store: orchestration.store,
    });
    const safePlan = buildVoicePlan(request);
    const workflow = orchestration.store.updateFields(request.workflow.id, { executionPlan: safePlan }, 'jarvis_voice_plan');
    const finalWorkflow = await orchestration.runner.run(workflow.id);
    if (typeof orchestration.notify === 'function') orchestration.notify(finalWorkflow);
    if (finalWorkflow.status !== 'completed') {
      throw jsonError(finalWorkflow.lastError || 'WorkBuddy 天气查询未完成', 502);
    }
    const workerResult = finalWorkflow.lastResult && finalWorkflow.lastResult.stdout;
    const summary = summarizeWorkerOutput(workerResult);
    let audioResult = null;
    try { audioResult = await synthesize(summary); } catch (error) {
      // 天气查询已经完成时，TTS 失败不应丢失详细结果；响应会明确告知前端没有音频。
      audioResult = { error: error.message || '语音合成失败' };
    }
    const detailPath = writeSessionDetail({
      projectPath: canonicalProjectPath, sessionId, receivedAt, audioType: type,
      transcript, intent, prompt, workerResult, summary, audio: audioResult && audioResult.url ? audioResult : null,
    });
    return {
      ok: true, sessionId, transcript, intent, summary, detailPath,
      workflow: { id: finalWorkflow.id, status: finalWorkflow.status }, audio: audioResult,
    };
  }

  function readAudio(fileName) {
    const safeName = path.basename(String(fileName || ''));
    if (safeName !== fileName || !/^jarvis-[\w-]+\.wav$/.test(safeName)) return null;
    const filePath = path.join(paths.audioDir, safeName);
    try { return fs.readFileSync(filePath); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }

  return { readiness, handleVoice, readAudio, parseWeatherIntent, normalizeIntent, buildWeatherPrompt };
}

module.exports = {
  DEFAULTS,
  parseWeatherIntent,
  normalizeIntent,
  parseWorkerOutput,
  summarizeWorkerOutput,
  createJarvisVoiceRuntime,
};
