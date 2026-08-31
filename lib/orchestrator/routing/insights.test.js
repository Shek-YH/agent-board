'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const {
  aggregateRoutingOutcomes,
  aggregateWorkspaceRoutingOutcomes,
  recommendExecutionProfile,
  checkRoutingWorkspace,
} = require('./insights');

const catalog = {
  source: 'native', available: true, stale: false,
  models: [
    { id: 'strong', visibility: 'list', supportedInApi: true, supportedReasoningLevels: ['high'] },
    { id: 'balanced', visibility: 'list', supportedInApi: true, supportedReasoningLevels: ['medium'] },
  ],
};

test('aggregates verified routing outcomes without retaining instruction fields', () => {
  const result = aggregateRoutingOutcomes({
    dispatchRecords: [
      { state: 'committed', routing: { modelId: 'strong', reasoningLevel: 'high' }, instruction: 'drop', token: 'drop' },
      { state: 'failed', routing: { modelId: 'strong', reasoningLevel: 'high' }, instruction: 'drop', token: 'drop' },
      { state: 'committed', routing: { modelId: 'balanced', reasoningLevel: 'medium' } },
    ],
  });

  assert.deepEqual(result, {
    totalAttempts: 3, totalSuccesses: 2, totalFailures: 1,
    profiles: [
      { modelId: 'strong', reasoningLevel: 'high', attempts: 2, successes: 1, failures: 1, successRate: 0.5 },
      { modelId: 'balanced', reasoningLevel: 'medium', attempts: 1, successes: 1, failures: 0, successRate: 1 },
    ],
  });
  assert.equal(JSON.stringify(result).includes('drop'), false);
});

test('aggregates workspace routing outcomes by Agent and profile without guessing ownership', () => {
  const result = aggregateWorkspaceRoutingOutcomes({
    workflows: [
      { id: 'codex-workflow', agent: 'Codex' },
      { id: 'hermes-workflow', agent: 'Hermes' },
    ],
    dispatchRecords: [
      { workflowId: 'codex-workflow', state: 'committed', routing: { modelId: 'strong', reasoningLevel: 'high' }, instruction: 'drop', token: 'drop' },
      { workflowId: 'codex-workflow', state: 'failed', routing: { modelId: 'strong', reasoningLevel: 'high' }, prompt: 'drop' },
      { workflowId: 'hermes-workflow', state: 'committed', routing: { modelId: 'balanced', reasoningLevel: 'medium' } },
      { workflowId: 'unknown-workflow', state: 'committed', routing: { modelId: 'unsafe', reasoningLevel: 'high' } },
      { workflowId: 'codex-workflow', state: 'running', routing: { modelId: 'ignored', reasoningLevel: 'high' } },
      { workflowId: 'codex-workflow', state: 'committed', routing: { modelId: '', reasoningLevel: 'high' } },
    ],
  });

  assert.deepEqual(result, {
    totalAttempts: 3,
    totalSuccesses: 2,
    totalFailures: 1,
    agents: [
      { agent: 'codex', attempts: 2, successes: 1, failures: 1, successRate: 0.5 },
      { agent: 'hermes', attempts: 1, successes: 1, failures: 0, successRate: 1 },
    ],
    profiles: [
      { agent: 'codex', modelId: 'strong', reasoningLevel: 'high', attempts: 2, successes: 1, failures: 1, successRate: 0.5 },
      { agent: 'hermes', modelId: 'balanced', reasoningLevel: 'medium', attempts: 1, successes: 1, failures: 0, successRate: 1 },
    ],
  });
  assert.equal(JSON.stringify(result).includes('drop'), false);
  assert.equal(JSON.stringify(result).includes('unsafe'), false);
});

test('limits workspace flywheel aggregation to the most recent safe records', () => {
  const result = aggregateWorkspaceRoutingOutcomes({
    maxRecords: 2,
    workflows: [{ id: 'codex-workflow', agent: 'codex' }],
    dispatchRecords: [
      { workflowId: 'codex-workflow', state: 'committed', routing: { modelId: 'old', reasoningLevel: 'low' } },
      { workflowId: 'codex-workflow', state: 'committed', routing: { modelId: 'new', reasoningLevel: 'high' } },
      { workflowId: 'codex-workflow', state: 'failed', routing: { modelId: 'new', reasoningLevel: 'high' } },
    ],
  });

  assert.equal(result.totalAttempts, 2);
  assert.deepEqual(result.profiles, [
    { agent: 'codex', modelId: 'new', reasoningLevel: 'high', attempts: 2, successes: 1, failures: 1, successRate: 0.5 },
  ]);
});

test('recommends a historically successful profile without overriding explicit manual pin', () => {
  const recommendation = recommendExecutionProfile({
    catalog, modelOrder: ['strong', 'balanced'], complexityTier: 'C1', thinkingTier: 'T1',
    outcomes: {
      profiles: [{ modelId: 'strong', reasoningLevel: 'high', attempts: 5, successes: 1, failures: 4, successRate: 0.2 },
        { modelId: 'balanced', reasoningLevel: 'medium', attempts: 5, successes: 5, failures: 0, successRate: 1 }],
    },
  });
  assert.equal(recommendation.reasonCode, 'HISTORICAL_PROFILE_RECOMMENDED');
  assert.equal(recommendation.profile.modelId, 'balanced');

  const pinned = recommendExecutionProfile({
    catalog, modelOrder: ['strong', 'balanced'], complexityTier: 'C1', thinkingTier: 'T1',
    manualPin: { modelId: 'strong', reasoningLevel: 'high' }, outcomes: recommendation,
  });
  assert.equal(pinned.reasonCode, 'MANUAL_PIN');
  assert.equal(pinned.profile.modelId, 'strong');
});

test('rejects routing outside configured project roots', () => {
  const root = path.join('C:', 'agent-board', 'projects');
  assert.deepEqual(checkRoutingWorkspace({ projectPath: path.join(root, 'app'), allowedRoots: [root] }), {
    safe: true, reasonCode: 'WORKSPACE_IN_SCOPE',
  });
  assert.deepEqual(checkRoutingWorkspace({ projectPath: path.join('C:', 'other'), allowedRoots: [root] }), {
    safe: false, reasonCode: 'WORKSPACE_OUT_OF_SCOPE',
  });
});
