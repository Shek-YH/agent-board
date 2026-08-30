'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCodexAppServerCapability } = require('./codex-app-server');

const THREAD_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_REF = `codex:${THREAD_ID}`;

test('reads the native model catalog through model/list', async () => {
  const calls = [];
  const capability = createCodexAppServerCapability({
    agentVersion: '0.151.0',
    request: async (method, params) => {
      calls.push({ method, params });
      return {
        data: [{
          id: 'gpt-5.6-sol', model: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol', hidden: false,
          defaultReasoningEffort: 'medium',
          supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }],
        }],
      };
    },
  });

  const catalog = await capability.listModels();

  assert.deepEqual(calls, [{ method: 'model/list', params: { includeHidden: false } }]);
  assert.equal(catalog.source, 'native');
  assert.equal(catalog.agentVersion, '0.151.0');
  assert.deepEqual(catalog.models[0].supportedReasoningLevels, ['low', 'high']);
});

test('applies a real session profile and verifies exact settings notification', async () => {
  const calls = [];
  const capability = createCodexAppServerCapability({
    request: async (method, params) => {
      calls.push({ method, params });
      return {};
    },
    waitForNotification: async ({ method, predicate }) => {
      assert.equal(method, 'thread/settings/updated');
      const notification = {
        method,
        params: {
          threadId: THREAD_ID,
          threadSettings: {
            model: 'gpt-5.6-sol',
            effort: 'high',
            modelProvider: 'OpenAI',
          },
        },
      };
      assert.equal(predicate(notification), true);
      return notification;
    },
  });

  const result = await capability.applyProfile({
    sessionRef: SESSION_REF,
    profile: { modelId: 'gpt-5.6-sol', reasoningLevel: 'high' },
  });

  assert.deepEqual(calls, [{
    method: 'thread/settings/update',
    params: { threadId: THREAD_ID, model: 'gpt-5.6-sol', effort: 'high' },
  }]);
  assert.deepEqual(result.readback, {
    modelId: 'gpt-5.6-sol', reasoningLevel: 'high', threadId: THREAD_ID, source: 'native',
  });
  assert.equal(result.verified, true);
});

test('fails closed when the settings notification belongs to another session', async () => {
  const capability = createCodexAppServerCapability({
    request: async () => ({}),
    waitForNotification: async ({ method }) => ({
      method,
      params: {
        threadId: '22222222-2222-4222-8222-222222222222',
        threadSettings: { model: 'gpt-5.6-sol', effort: 'high' },
      },
    }),
  });

  await assert.rejects(
    capability.applyProfile({
      sessionRef: SESSION_REF,
      profile: { modelId: 'gpt-5.6-sol', reasoningLevel: 'high' },
    }),
    (error) => error && error.code === 'SESSION_DRIFT',
  );
});

test('preserves explicit human profile-change evidence for manual pin detection', async () => {
  const capability = createCodexAppServerCapability({
    request: async () => ({}),
  });
  const result = await capability.readProfile({
    sessionRef: SESSION_REF,
    notification: {
      params: {
        threadId: THREAD_ID,
        changedBy: 'human',
        threadSettings: { model: 'gpt-5.6-sol', effort: 'high' },
      },
    },
  });

  assert.deepEqual(result, {
    modelId: 'gpt-5.6-sol', reasoningLevel: 'high', threadId: THREAD_ID, source: 'native',
    manualPin: true, changedBy: 'human',
  });
});
