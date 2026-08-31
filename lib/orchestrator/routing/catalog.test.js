'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeCatalogResponse,
  findModel,
  getSupportedReasoning,
  isCatalogFresh,
} = require('./catalog');

test('normalizes the runtime model catalog and keeps only safe model metadata', () => {
  const catalog = normalizeCatalogResponse({
    models: [
      {
        slug: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol', description: 'strong',
        default_reasoning_level: 'medium',
        supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }, { effort: 'high' }],
        visibility: 'list', supported_in_api: true, context_window: 272000,
      },
      { slug: 'hidden-model', display_name: 'Hidden', visibility: 'hide', supported_in_api: true },
      { slug: '', display_name: 'invalid' },
      'invalid entry',
    ],
  }, {
    source: 'native', fetchedAt: '2026-08-30T17:05:21.177Z', agentVersion: '0.151.0', etag: 'etag-1',
  });

  assert.deepEqual(catalog, {
    source: 'native', fetchedAt: '2026-08-30T17:05:21.177Z', agentVersion: '0.151.0', etag: 'etag-1',
    models: [{
      id: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol', description: 'strong', defaultReasoningLevel: 'medium',
      supportedReasoningLevels: ['low', 'high'], visibility: 'list', supportedInApi: true,
      contextWindow: 272000, maxContextWindow: null,
    }],
  });
  assert.equal(findModel(catalog, 'gpt-5.6-sol').id, 'gpt-5.6-sol');
  assert.equal(findModel(catalog, 'hidden-model'), null);
  assert.equal(findModel(catalog, 'hidden-model', { includeHidden: true }), null);
  assert.deepEqual(getSupportedReasoning(catalog.models[0]), ['low', 'high']);
});

test('accepts a legacy catalog payload and distinguishes fresh from stale cache', () => {
  const catalog = normalizeCatalogResponse({
    data: [{ slug: 'gpt-5.4-mini', display_name: 'Mini', supported_reasoning_levels: ['low', 'medium'] }],
  }, { source: 'cache', fetchedAt: 1_000, agentVersion: '0.151.0' });

  assert.deepEqual(getSupportedReasoning(catalog.models[0]), ['low', 'medium']);
  assert.equal(isCatalogFresh(catalog, 1_000 + 4_999, 5_000), true);
  assert.equal(isCatalogFresh(catalog, 1_000 + 5_000, 5_000), false);
  assert.equal(isCatalogFresh({ ...catalog, agentVersion: '0.150.0' }, 1_001, 5_000, '0.151.0'), false);
});

test('normalizes the native app-server camelCase model response', () => {
  const catalog = normalizeCatalogResponse({
    data: [{
      id: 'gpt-5.6-sol', model: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol', hidden: false,
      defaultReasoningEffort: 'medium',
      supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }, { reasoningEffort: 'high' }],
      multiAgentVersion: 'v2',
      description: 'native', isDefault: true,
    }],
  }, { source: 'native', fetchedAt: 10, agentVersion: '0.151.0' });

  assert.deepEqual(catalog.models[0], {
    id: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol', description: 'native', defaultReasoningLevel: 'medium',
    supportedReasoningLevels: ['low', 'medium', 'high'], visibility: 'list', supportedInApi: true,
    contextWindow: null, maxContextWindow: null,
    multiAgentVersion: 'v2',
  });
});

test('preserves the runtime model version and every supported reasoning value returned by the agent', () => {
  const catalog = normalizeCatalogResponse({
    data: [{
      id: 'gpt-5.6-luna', model: 'gpt-5.6-luna', displayName: 'GPT-5.6-Luna', hidden: false,
      version: '2026.08',
      defaultReasoningEffort: 'medium',
      supportedReasoningEfforts: [
        { reasoningEffort: 'none' }, { reasoningEffort: 'low' }, { reasoningEffort: 'medium' },
        { reasoningEffort: 'high' }, { reasoningEffort: 'xhigh' }, { reasoningEffort: 'max' },
      ],
    }],
  });

  assert.equal(catalog.models[0].version, '2026.08');
  assert.deepEqual(catalog.models[0].supportedReasoningLevels, ['none', 'low', 'medium', 'high', 'xhigh', 'max']);
});

test('excludes hidden models but retains legacy metadata for explicit opt-in routing', () => {
  const result = normalizeCatalogResponse({ data: [
    { id: 'hidden', model: 'hidden', hidden: true, supportedReasoningEfforts: [{ reasoningEffort: 'high' }] },
    { id: 'legacy', model: 'legacy', isLegacy: true, supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] },
    { id: 'current', model: 'current', hidden: false, supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] },
  ] });

  assert.deepEqual(result.models.map((model) => ({ id: model.id, legacy: model.legacy === true })), [
    { id: 'legacy', legacy: true },
    { id: 'current', legacy: false },
  ]);
});
