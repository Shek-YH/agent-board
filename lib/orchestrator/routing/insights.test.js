'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const {
  aggregateRoutingOutcomes,
  aggregateHistoricalTaskOutcomes,
  aggregateWorkspaceRoutingOutcomes,
  recommendHistoricalProfile,
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
    taskClasses: [],
    taskProfiles: [],
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

test('aggregates terminal task outcomes with safe task metrics and human intervention', () => {
  const result = aggregateHistoricalTaskOutcomes({
    workflows: [
      {
        id: 'wf-success', agent: 'Codex', classification: { kind: 'existing' }, startedAt: 1_000, endedAt: 5_000,
        runCount: 2, runReceipt: {
          finalState: 'DONE', iterations: 2, dod: { passed: 2, total: 2 }, counters: { stagnation: 1 },
          routing: { modelId: 'strong', reasoningLevel: 'high' }, goal: 'drop', projectPath: 'drop',
        },
      },
      {
        id: 'wf-blocked', agent: 'codex', classification: { kind: 'existing' }, startedAt: 1_000, endedAt: 10_000,
        runCount: 4, stopReason: 'Need Human', runReceipt: {
          finalState: 'BLOCKED', iterations: 4, dod: { passed: 1, total: 2 }, counters: { stagnation: 3 },
          routing: { modelId: 'strong', reasoningLevel: 'high' },
        },
      },
      {
        id: 'wf-hermes', agent: 'hermes', classification: { kind: 'new' }, startedAt: 2_000, endedAt: 3_000,
        runReceipt: {
          finalState: 'DONE', iterations: 1, dod: { passed: 1, total: 1 }, counters: { stagnation: 0 },
          routing: { modelId: 'model-only', reasoningLevel: null },
        },
      },
      { id: 'wf-paused', agent: 'codex', classification: { kind: 'existing' }, runReceipt: { finalState: 'PAUSED' } },
    ],
    events: [{ workflowId: 'wf-blocked', type: 'takeover', at: 9_000, secret: 'drop' }],
  });

  assert.deepEqual(result.taskClasses, [
    {
      agent: 'codex', taskClass: 'existing', attempts: 2, successes: 1, failures: 1, successRate: 0.5,
      averageIterations: 3, averageDurationMs: 6_500, averageDodCompletionRate: 0.75,
      humanInterventions: 1, averageStagnation: 2,
    },
    {
      agent: 'hermes', taskClass: 'new', attempts: 1, successes: 1, failures: 0, successRate: 1,
      averageIterations: 1, averageDurationMs: 1_000, averageDodCompletionRate: 1,
      humanInterventions: 0, averageStagnation: 0,
    },
  ]);
  assert.deepEqual(result.taskProfiles, [
    {
      agent: 'codex', taskClass: 'existing', modelId: 'strong', reasoningLevel: 'high', attempts: 2,
      successes: 1, failures: 1, successRate: 0.5, averageIterations: 3, averageDurationMs: 6_500,
      averageDodCompletionRate: 0.75, humanInterventions: 1, averageStagnation: 2,
    },
    {
      agent: 'hermes', taskClass: 'new', modelId: 'model-only', reasoningLevel: null, attempts: 1,
      successes: 1, failures: 0, successRate: 1, averageIterations: 1, averageDurationMs: 1_000,
      averageDodCompletionRate: 1, humanInterventions: 0, averageStagnation: 0,
    },
  ]);
  assert.equal(JSON.stringify(result).includes('drop'), false);
});

test('recommends a historical profile only for the same Agent and task class after enough samples', () => {
  const insufficientProfiles = [
    { agent: 'codex', taskClass: 'existing', modelId: 'strong', reasoningLevel: 'high', attempts: 2, successes: 2, successRate: 1 },
  ];
  const insufficient = recommendHistoricalProfile({
    catalog, modelOrder: ['strong', 'balanced'], agent: 'codex', taskClass: 'existing', taskProfiles: insufficientProfiles,
  });
  assert.deepEqual(insufficient, { profile: null, reasonCode: 'INSUFFICIENT_HISTORY', sampleSize: 2, minAttempts: 3 });

  const taskProfiles = [
    { agent: 'codex', taskClass: 'existing', modelId: 'strong', reasoningLevel: 'high', attempts: 2, successes: 2, successRate: 1 },
    { agent: 'codex', taskClass: 'existing', modelId: 'balanced', reasoningLevel: 'medium', attempts: 3, successes: 3, successRate: 1 },
    { agent: 'codex', taskClass: 'new', modelId: 'strong', reasoningLevel: 'high', attempts: 10, successes: 10, successRate: 1 },
    { agent: 'hermes', taskClass: 'existing', modelId: 'balanced', reasoningLevel: 'medium', attempts: 10, successes: 10, successRate: 1 },
  ];

  const recommendation = recommendHistoricalProfile({
    catalog, modelOrder: ['strong', 'balanced'], agent: 'codex', taskClass: 'existing', taskProfiles,
  });
  assert.equal(recommendation.reasonCode, 'HISTORICAL_PROFILE_RECOMMENDED');
  assert.equal(recommendation.profile.modelId, 'balanced');
  assert.equal(recommendation.sampleSize, 5);
  assert.equal(recommendation.minAttempts, 3);

  const pinned = recommendHistoricalProfile({
    catalog, modelOrder: ['strong', 'balanced'], agent: 'codex', taskClass: 'existing', taskProfiles,
    manualPin: { modelId: 'strong', reasoningLevel: 'high' },
  });
  assert.equal(pinned.reasonCode, 'MANUAL_PIN');
  assert.equal(pinned.profile.modelId, 'strong');
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
