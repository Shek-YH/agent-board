'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeRunContract } = require('./run-contract');
const { buildSuggestion, createSuggestionService } = require('./suggestion-engine');

function draftContract() {
  return normalizeRunContract({ goal: '完成目标', verify: { dod: ['检查完成'] } });
}

function draftWorkflow(fields = {}) {
  return {
    id: 'wf-1', projectPath: 'C:\Projects\demo', agent: 'codex', status: 'draft',
    controlOwner: null, runCount: 0, createdAt: 1_000, lastResult: null,
    observedEvidence: [], runContract: draftContract(), ...fields,
  };
}

function completedWithEvidence() {
  return draftWorkflow({
    status: 'completed',
    observedEvidence: [{ dodIndex: 0, passed: true, summary: '检查完成', source: 'test' }],
  });
}

function fakeStore(initial) {
  let current = { ...initial };
  return {
    get(id) { return id === current.id ? { ...current } : null; },
    updateFields(id, fields) {
      if (id !== current.id) throw new Error('workflow not found');
      current = { ...current, ...fields };
      return { ...current };
    },
  };
}

test('suggests a read-and-verify next step without a sendable prompt', () => {
  const result = buildSuggestion({ workflow: draftWorkflow(), now: 2_000, suggestionId: 'sug-1' });
  assert.equal(result.action, 'suggest');
  assert.equal(result.requiresHuman, false);
  assert.equal(result.turnContract.send, false);
  assert.equal('prompt' in result.turnContract, false);
  assert.equal(result.receipt.suggestionId, 'sug-1');
});

test('requires human after takeover, failure, or budget exhaustion', () => {
  assert.equal(buildSuggestion({ workflow: draftWorkflow({ controlOwner: 'human' }) }).action, 'need_human');
  assert.equal(buildSuggestion({ workflow: draftWorkflow({ status: 'failed' }) }).reason, 'Blocked');
  assert.equal(buildSuggestion({ workflow: draftWorkflow({ runCount: 3 }) }).reason, 'Budget Exceeded');
});

test('stops only with explicit evidence for every DoD', () => {
  const workflow = completedWithEvidence();
  const result = buildSuggestion({ workflow, suggestionId: 'sug-done' });
  assert.equal(result.action, 'stop');
  assert.equal(result.reason, 'DoD Complete');
});

test('service serializes same-workflow suggestions and persists only safe fields', async () => {
  const store = fakeStore(draftWorkflow());
  const service = createSuggestionService({ store, now: () => 2_000, id: () => 'sug-serial' });
  const [first, second] = await Promise.all([service.suggest('wf-1'), service.suggest('wf-1')]);
  assert.equal(first.lastSuggestion.suggestionId, 'sug-serial');
  assert.equal(second.lastSuggestion.suggestionId, 'sug-serial');
  assert.equal('implementation' in JSON.parse(JSON.stringify(first)), false);
});
