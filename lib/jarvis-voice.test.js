'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { WorkflowStore } = require('./orchestrator/workflow-store');
const { WorkflowRunner } = require('./orchestrator/runner');
const { createJarvisVoiceRuntime, normalizeIntent, parseWeatherIntent } = require('./jarvis-voice');

function setup(fetchImpl) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-jarvis-'));
  const projectRoot = path.join(dir, 'projects');
  fs.mkdirSync(projectRoot, { recursive: true });
  const store = new WorkflowStore(path.join(dir, 'workflows.json'));
  const orchestration = {
    store,
    allowedRoots: [projectRoot],
    transport: { workbuddyCliPath: 'C:\\WorkBuddy\\codebuddy' },
    runner: new WorkflowRunner({
      store,
      allowedRoots: [projectRoot],
      transport: { run: async () => ({
        status: 'completed', code: 0,
        stdout: JSON.stringify([{ type: 'result', result: '明天深圳多云，最高 30℃，最低 25℃，降雨概率 20%。' }]),
        stderr: '',
      }) },
    }),
  };
  const env = { AGENT_BOARD_HEADLESS_EXECUTION: '1', ZAI_API_KEY: 'test-key' };
  const runtime = createJarvisVoiceRuntime({ orchestration, env, dataDir: dir, fetchImpl });
  return { dir, projectRoot, runtime, store };
}

test('weather intent accepts the MVP voice phrase but rejects arbitrary actions', () => {
  assert.deepEqual(parseWeatherIntent('用workbuddy查一下明天深圳的天气'), {
    action: 'weather_lookup', city: '深圳', date: 'tomorrow', worker: 'workbuddy',
  });
  assert.deepEqual(normalizeIntent({ action: 'shell', command: 'dir' }, 'x'), null);
});

test('Jarvis voice runtime completes ASR -> intent -> WorkBuddy -> TTS and writes detail session', async () => {
  const calls = [];
  const { dir, projectRoot, runtime, store } = setup(async (url, options) => {
    calls.push({ url, options });
    if (url.includes('/audio/transcriptions')) return { ok: true, status: 200, json: async () => ({ text: '用workbuddy查一下明天深圳的天气' }) };
    if (url.includes('/chat/completions')) return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"action":"weather_lookup","city":"深圳","date":"tomorrow"}' } }] }) };
    if (url.includes('/audio/speech')) return { ok: true, status: 200, arrayBuffer: async () => Buffer.from('RIFF-test-audio') };
    throw new Error(`unexpected URL: ${url}`);
  });

  const result = await runtime.handleVoice({
    audioBase64: Buffer.from('test-recording').toString('base64'),
    mimeType: 'audio/webm',
    projectPath: path.join(projectRoot, 'weather-session'),
  });

  assert.equal(result.ok, true);
  assert.equal(result.transcript, '用workbuddy查一下明天深圳的天气');
  assert.equal(result.intent.city, '深圳');
  assert.match(result.summary, /明天深圳/);
  assert.equal(result.workflow.status, 'completed');
  assert.equal(store.list()[0].requestedBy, 'jarvis-voice');
  assert.equal(fs.existsSync(result.detailPath), true);
  assert.match(fs.readFileSync(result.detailPath, 'utf8'), /WorkBuddy 完整返回/);
  assert.match(fs.readFileSync(result.detailPath, 'utf8'), /深圳/);
  assert.equal(result.audio.mimeType, 'audio/wav');
  assert.equal(runtime.readAudio(result.audio.fileName).toString(), 'RIFF-test-audio');
  assert.equal(calls.length, 3);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer test-key');
  assert.equal(calls[1].options.headers.Authorization, 'Bearer test-key');
  assert.equal(fs.existsSync(path.join(dir, 'jarvis-audio', result.audio.fileName)), true);
});

test('voice readiness exposes capability booleans without API key values', () => {
  const { runtime } = setup(async () => ({ ok: true, json: async () => ({}) }));
  const readiness = runtime.readiness();
  assert.equal(readiness.asr.available, true);
  assert.equal(readiness.supervisor.available, true);
  assert.equal(readiness.tts.available, true);
  assert.equal(JSON.stringify(readiness).includes('test-key'), false);
});
