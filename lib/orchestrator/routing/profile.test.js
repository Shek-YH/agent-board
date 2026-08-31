'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveExecutionProfile } = require('./profile');

function catalog() {
  return {
    source: 'native',
    models: [
      { id: 'strong', supportedReasoningLevels: ['low', 'medium', 'high', 'max'], visibility: 'list' },
      { id: 'balanced', supportedReasoningLevels: ['low', 'medium', 'high'], visibility: 'list' },
      { id: 'fast', supportedReasoningLevels: ['low', 'medium'], visibility: 'list' },
    ],
  };
}

test('resolves C0-C3 and T0-T3 using an agent-provided model order', () => {
  const common = { catalog: catalog(), modelOrder: ['strong', 'balanced', 'fast'], promptPolicy: 'P1' };
  assert.equal(resolveExecutionProfile({ ...common, complexityTier: 'C0', thinkingTier: 'T0' }).modelId, 'fast');
  assert.equal(resolveExecutionProfile({ ...common, complexityTier: 'C1', thinkingTier: 'T1' }).modelId, 'balanced');
  assert.equal(resolveExecutionProfile({ ...common, complexityTier: 'C2', thinkingTier: 'T2' }).modelId, 'strong');
  assert.deepEqual(resolveExecutionProfile({ ...common, complexityTier: 'C3', thinkingTier: 'T3' }), {
    modelId: 'strong', reasoningLevel: 'max', complexityTier: 'C3', thinkingTier: 'T3', promptPolicy: 'P1',
    fallbackApplied: true, fallbackReason: 'requested reasoning ultra is unsupported; mapped to max', reasonCode: 'PROFILE_RESOLVED',
  });
});

test('maps unsupported reasoning to the closest legal level and respects manual pins', () => {
  const mapped = resolveExecutionProfile({
    catalog: catalog(), modelOrder: ['strong', 'balanced', 'fast'], complexityTier: 'C2', thinkingTier: 'T3', promptPolicy: 'P2',
  });
  assert.equal(mapped.modelId, 'strong');
  assert.equal(mapped.reasoningLevel, 'max');
  assert.equal(mapped.fallbackApplied, true);
  assert.match(mapped.fallbackReason, /unsupported/);

  const fallback = resolveExecutionProfile({
    catalog: catalog(), modelOrder: ['balanced'], complexityTier: 'C3', thinkingTier: 'T3', promptPolicy: 'P0',
  });
  assert.equal(fallback.reasoningLevel, 'high');
  assert.equal(fallback.fallbackApplied, true);
  assert.match(fallback.fallbackReason, /unsupported/);

  const pinned = resolveExecutionProfile({
    catalog: catalog(), modelOrder: ['strong', 'balanced', 'fast'], complexityTier: 'C0', thinkingTier: 'T0', promptPolicy: 'P0',
    manualPin: { modelId: 'balanced', reasoningLevel: 'high' },
  });
  assert.equal(pinned.modelId, 'balanced');
  assert.equal(pinned.reasoningLevel, 'high');
  assert.equal(pinned.manualPin, true);
});

test('fails closed when the requested model order has no catalog match', () => {
  const result = resolveExecutionProfile({
    catalog: catalog(), modelOrder: ['missing'], complexityTier: 'C1', thinkingTier: 'T1', promptPolicy: 'P1',
  });
  assert.equal(result.modelId, null);
  assert.equal(result.reasonCode, 'MODEL_UNAVAILABLE');
});

test('excludes legacy models unless routing explicitly opts in', () => {
  const legacyCatalog = {
    models: [{ id: 'legacy', legacy: true, visibility: 'list', supportedReasoningLevels: ['medium'] }],
  };

  assert.equal(resolveExecutionProfile({
    catalog: legacyCatalog, modelOrder: ['legacy'], complexityTier: 'C1', thinkingTier: 'T1',
  }).reasonCode, 'MODEL_UNAVAILABLE');
  assert.equal(resolveExecutionProfile({
    catalog: legacyCatalog, modelOrder: ['legacy'], complexityTier: 'C1', thinkingTier: 'T1', allowLegacyModels: true,
  }).reasonCode, 'PROFILE_RESOLVED');
});

test('resolves a model-only profile when the agent has no reasoning selector', () => {
  const result = resolveExecutionProfile({
    catalog: { models: [{ id: 'model-only', visibility: 'list', supportedReasoningLevels: [] }] },
    modelOrder: ['model-only'], complexityTier: 'C1', thinkingTier: 'T1', requireReasoning: false,
  });

  assert.equal(result.reasonCode, 'PROFILE_RESOLVED');
  assert.equal(result.modelId, 'model-only');
  assert.equal(result.reasoningLevel, null);
  assert.equal(result.reasoningControl, false);
});

test('never emits an unsupported reasoning value from a real model capability list', () => {
  const result = resolveExecutionProfile({
    catalog: {
      models: [{
        id: 'gpt-5.6-luna', visibility: 'list', defaultReasoningLevel: 'medium',
        supportedReasoningLevels: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
      }],
    },
    modelOrder: ['gpt-5.6-luna'],
    manualPin: { modelId: 'gpt-5.6-luna', reasoningLevel: 'minimal' },
  });

  assert.notEqual(result.reasoningLevel, 'minimal');
  assert.ok(['none', 'low', 'medium', 'high', 'xhigh', 'max'].includes(result.reasoningLevel));
  assert.match(result.fallbackReason, /unsupported/);
});
