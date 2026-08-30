'use strict';

const crypto = require('node:crypto');
const { calculateProgress } = require('./progress');

function suggestionError(message) {
  return new TypeError('Invalid suggestion: ' + message);
}

function createSuggestionId() {
  return 'sug-' + crypto.randomUUID();
}

function buildTurnContract(workflow, action) {
  const contract = workflow.runContract;
  return {
    version: 1,
    action,
    goal: contract.goal,
    scope: {
      inScope: [...contract.scope.inScope],
      outOfScope: [...contract.scope.outOfScope],
    },
    acceptance: {
      dod: [...contract.verify.dod],
      evidence: [...contract.verify.evidence],
    },
    target: {
      agent: String(workflow.agent || ''),
      projectPath: String(workflow.projectPath || ''),
      sessionRef: null,
    },
    stop: [...contract.stop],
    send: false,
  };
}

function buildSuggestion({ workflow, now = Date.now(), suggestionId = createSuggestionId() } = {}) {
  if (!workflow || typeof workflow !== 'object') throw suggestionError('workflow is required');
  if (!workflow.runContract) throw suggestionError('runContract is required');
  const id = String(suggestionId || '').trim();
  if (!id) throw suggestionError('suggestionId is required');
  const timestamp = Number.isFinite(now) ? now : Date.now();
  const progress = calculateProgress({ workflow, now: timestamp });

  let action = 'suggest';
  let reason = '需要读取当前项目状态并根据 DoD 收集证据';
  let nextStep = '读取项目状态，逐项收集 Definition of Done 对应的 Evidence';
  let requiresHuman = false;

  if (progress.status === 'completed') {
    action = 'stop';
    reason = 'DoD Complete';
    nextStep = '停止当前 AutoPilot Run，等待新的 Human 目标';
  } else if (progress.status === 'blocked') {
    action = 'need_human';
    reason = progress.stopReason || 'Need Human';
    nextStep = '请人工检查阻止原因并决定是否接管或更新目标';
    requiresHuman = true;
  }

  return {
    suggestionId: id,
    action,
    reason,
    nextStep,
    requiresHuman,
    turnContract: buildTurnContract(workflow, action),
    progress,
    receipt: {
      workflowId: String(workflow.id || ''),
      suggestionId: id,
      generatedAt: new Date(timestamp).toISOString(),
      action,
      dodTotal: progress.total,
      dodPassed: progress.completed,
      evidenceCount: progress.evidence.length,
      state: progress.status,
    },
  };
}

function createSuggestionService({ store, now = () => Date.now(), id = createSuggestionId } = {}) {
  if (!store || typeof store.get !== 'function' || typeof store.updateFields !== 'function') {
    throw new TypeError('workflow store is required');
  }
  const locks = new Map();

  function suggest(workflowId) {
    const key = String(workflowId || '');
    const previous = locks.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(() => {
      const workflow = store.get(key);
      if (!workflow) return null;
      const suggestion = buildSuggestion({ workflow, now: now(), suggestionId: id() });
      return store.updateFields(key, {
        lastSuggestion: suggestion,
        progress: suggestion.progress,
        lastReceipt: suggestion.receipt,
      }, 'suggestion_created');
    });
    locks.set(key, current);
    const cleanup = () => {
      if (locks.get(key) === current) locks.delete(key);
    };
    current.then(cleanup, cleanup);
    return current;
  }

  return Object.freeze({ suggest });
}

module.exports = { buildSuggestion, createSuggestionService };
