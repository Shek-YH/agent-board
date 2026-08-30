'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const codex = require('../../adapters/codex');
const detect = require('../../detect');
const { createCodexAppServerCapability } = require('./codex-app-server');
const { createCodexAppServerClient } = require('./codex-app-server-client');
const { createRoutingRuntime } = require('./runtime');

const THREAD_ID = '11111111-1111-4111-8111-111111111111';

function workflow() {
  return {
    id: 'wf-poc', agent: 'codex', binding: { sessionRef: `codex:${THREAD_ID}` },
    routingConfig: { enabled: true, preset: 'balanced', modelOrder: ['gpt-5.6-sol'] },
    consecutiveFailures: 0, stagnationCount: 0, runCount: 0,
  };
}

test('POC completes catalog → profile verify → Verified Dispatch ordering', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-routing-poc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  const capability = {
    listModels: async () => ({
      data: [{ id: 'gpt-5.6-sol', model: 'gpt-5.6-sol', displayName: 'Sol', hidden: false,
        supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }, { reasoningEffort: 'high' }] }],
    }),
    applyProfile: async ({ profile }) => {
      calls.push('apply');
      return { ok: true, source: 'native', verified: true, readback: { modelId: profile.modelId, reasoningLevel: profile.reasoningLevel } };
    },
  };
  const runtime = createRoutingRuntime({ nativeCapability: capability, cachePath: path.join(dir, 'cache.json') });
  const outcome = await runtime.prepare({ workflow: workflow() });
  assert.equal(outcome.decision.action, 'apply');
  assert.equal(outcome.profileResult.ok, true);
  assert.equal(outcome.profileResult.verified, true);
  calls.push('dispatch');
  assert.deepEqual(calls, ['apply', 'dispatch']);
  assert.equal(outcome.auditEvent.profile.modelId, 'gpt-5.6-sol');
});

function resolveCodexExecutable() {
  const configured = String(process.env.AGENT_BOARD_CODEX_APP_SERVER_PATH || '').trim();
  if (configured && fs.existsSync(configured)) return configured;
  try {
    const probed = detect.probeAgent(codex, { userOverrides: detect.loadUserOverrides() }) || {};
    if (probed.executablePath) return probed.executablePath;
    const command = process.platform === 'win32' ? 'where.exe' : 'which';
    const result = spawnSync(command, ['codex'], { encoding: 'utf8', windowsHide: true });
    return result.status === 0 ? String(result.stdout || '').split(/\r?\n/).map((item) => item.trim()).find(Boolean) || null : null;
  } catch { return null; }
}

test('native Codex model/list POC', { skip: process.env.AGENT_BOARD_RUN_NATIVE_POC !== '1' }, async (t) => {
  const executablePath = resolveCodexExecutable();
  if (!executablePath) {
    t.skip('未探测到 codex CLI；设置 AGENT_BOARD_CODEX_APP_SERVER_PATH 后重试');
    return;
  }
  const client = createCodexAppServerClient({ executablePath, timeoutMs: 20_000 });
  t.after(() => client.close());
  const capability = createCodexAppServerCapability({
    request: client.request.bind(client),
    waitForNotification: client.waitForNotification.bind(client),
  });
  const catalog = await capability.listModels();
  assert.equal(catalog.source, 'native');
  assert.ok(catalog.models.length > 0, 'native model/list should return at least one visible API model');
  assert.ok(catalog.models.some((model) => model.supportedReasoningLevels.length > 0));
});
