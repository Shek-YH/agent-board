'use strict';

const crypto = require('node:crypto');
const { appendHostedAgentContract } = require('./hosted-agent');

function text(value, max = 2_000) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function errorFingerprint(value) {
  const message = text(value, 4_000);
  return message ? crypto.createHash('sha256').update(message, 'utf8').digest('hex').slice(0, 16) : null;
}

function stopReasonCode(reason) {
  return String(reason || 'BLOCKED').toUpperCase().replace(/[^A-Z]+/g, '_');
}

function safeReviewMetadata(reviewResult) {
  const result = reviewResult && typeof reviewResult === 'object' ? reviewResult : null;
  const review = result && result.review && typeof result.review === 'object' ? result.review : null;
  if (!result || !review) return null;
  return {
    source: text(result.source, 30) || 'deterministic',
    provider: text(result.provider, 50),
    model: text(result.model, 200),
    decision: text(review.decision, 30),
    summary: text(review.summary, 1_000),
    dodChecks: Array.isArray(review.dodChecks) ? review.dodChecks.map((item) => ({
      index: Number.isInteger(item && item.index) ? item.index : -1,
      status: text(item && item.status, 20),
      reason: text(item && item.reason, 500),
    })).filter((item) => item.index >= 0 && ['pass', 'fail', 'pending'].includes(item.status)).slice(0, 30) : [],
  };
}

function attachReview(decision, reviewResult) {
  const review = safeReviewMetadata(reviewResult);
  return review ? { ...decision, review } : decision;
}

function applySupervisorReview({ workflow, progress, decision, reviewResult, hostedReply } = {}) {
  const review = safeReviewMetadata(reviewResult);
  if (!review) return decision;
  const contract = workflow && workflow.runContract || {};
  const scope = contract.scope || { inScope: [] };
  const dod = contract.verify && Array.isArray(contract.verify.dod) ? contract.verify.dod : [];
  const ordinaryHostedQuestion = workflow && workflow.autopilotMode === 'auto'
    && hostedReply && hostedReply.requiresHostDecision === true
    && hostedReply.safetyBoundary !== true
    && hostedReply.status === 'question';
  if (review.decision === 'NEED_HUMAN' && ordinaryHostedQuestion) {
    const continuation = decision.decision === 'CONTINUE' ? decision : buildSupervisorDecision({
      workflow, progress: { ...(progress || {}), status: 'in_progress', evidence: [] },
    });
    return attachReview({
      ...continuation,
      decision: 'CONTINUE', reasonCode: 'HOSTED_AGENT_QUESTION',
      summary: '托管 Agent 的普通问题由 Supervisor 自动决定继续执行。',
    }, reviewResult);
  }
  if (review.decision === 'NEED_HUMAN') {
    return attachReview({
      ...decision,
      decision: 'NEED_HUMAN', reasonCode: 'AI_REVIEW_NEED_HUMAN',
      summary: review.summary || 'AI Supervisor 复核要求人工处理当前任务。',
      turnContract: {
        action: 'pause',
        targetDodItems: Array.isArray(decision.turnContract?.targetDodItems) ? decision.turnContract.targetDodItems : [],
        scope: [...(scope.inScope || [])], expectedResult: '人工处理 AI Supervisor 复核提出的问题',
      },
      instruction: '', riskLevel: 'MEDIUM',
    }, reviewResult);
  }
  if (decision.decision === 'DONE' && review.decision !== 'DONE') {
    const candidates = review.dodChecks.filter((item) => item.status !== 'pass').map((item) => item.index);
    const targetIndexes = [...new Set(candidates.filter((index) => index >= 0 && index < dod.length))];
    const indexes = targetIndexes.length ? targetIndexes : dod.map((_, index) => index);
    const evidence = Array.isArray(progress && progress.evidence)
      ? progress.evidence.filter((item) => !indexes.includes(item && item.dodIndex)) : [];
    const continuation = buildSupervisorDecision({
      workflow,
      progress: { ...(progress || {}), status: 'in_progress', evidence },
    });
    return attachReview({
      ...continuation,
      reasonCode: 'AI_REVIEW_REQUESTED_VERIFICATION',
      summary: review.summary || 'AI Supervisor 复核认为仍需补充可验证结果。',
      instruction: `${continuation.instruction}\n本轮为复核后的独立验证轮次，请重新执行验证并提供新的 Evidence。`,
    }, reviewResult);
  }
  return attachReview(decision, reviewResult);
}

function buildSupervisorDecision({ workflow, progress } = {}) {
  if (!workflow || typeof workflow !== 'object') throw new TypeError('workflow is required');
  if (!progress || typeof progress !== 'object') throw new TypeError('progress is required');
  const contract = workflow.runContract || {};
  const targetGoal = text(contract.goalSummary || contract.goal, 2_000);
  const dod = contract.verify && Array.isArray(contract.verify.dod) ? contract.verify.dod : [];
  const evidence = Array.isArray(progress.evidence) ? progress.evidence : [];
  const byIndex = new Map(evidence.map((item) => [item.dodIndex, item]));
  const dodChecks = dod.map((description, index) => {
    const item = byIndex.get(index);
    return {
      itemId: `dod-${index + 1}`,
      status: item ? (item.passed ? 'pass' : 'fail') : 'pending',
      source: item ? text(item.source, 200) : 'unverified',
      description: text(description),
    };
  });
  const pending = dodChecks.filter((item) => item.status !== 'pass');
  const scope = contract.scope || { inScope: [], outOfScope: [] };
  const base = {
    schemaVersion: '2.2',
    dodChecks,
    progress: {
      state: String(progress.status || 'not_started').toUpperCase(),
      regression: false,
      errorFingerprint: errorFingerprint(workflow.lastError),
    },
    scopeCheck: { withinGoal: true, withinScope: true },
    riskLevel: 'LOW',
  };

  if (progress.status === 'completed') {
    return {
      ...base, decision: 'DONE', reasonCode: 'DOD_COMPLETE', summary: `所有 ${dod.length} 项 DoD 均有明确通过证据`,
      turnContract: { action: 'stop', targetDodItems: [], scope: [...(scope.inScope || [])], expectedResult: 'DoD 全部完成' },
      instruction: '',
    };
  }
  if (progress.status === 'blocked') {
    const reason = progress.stopReason || 'Need Human';
    return {
      ...base, decision: 'NEED_HUMAN', reasonCode: stopReasonCode(reason), summary: `Auto Loop 已暂停：${reason}`,
      turnContract: { action: 'pause', targetDodItems: pending.map((item) => item.itemId), scope: [...(scope.inScope || [])], expectedResult: '人工处理阻塞原因' },
      instruction: '', riskLevel: 'MEDIUM',
    };
  }

  const targetDescriptions = pending.map((item) => item.description);
  const targetDodItems = pending.map((item) => item.itemId);
  const lines = [
    `继续完成目标：${targetGoal}`,
    `范围内：${(scope.inScope || []).join('；') || '仅处理 Run Contract 目标'}`,
    `范围外：${(scope.outOfScope || []).join('；') || '不扩展未声明的工作'}`,
    `当前未完成 DoD：${targetDescriptions.join('；')}`,
    '完成后请提供每项对应的可验证 Evidence，不要执行范围外操作。',
  ];
  const instruction = lines.join('\n');
  return {
    ...base,
    decision: 'CONTINUE',
    reasonCode: evidence.some((item) => item.passed === false) ? 'DOD_ITEM_FAILED' : 'INITIAL_REVIEW',
    summary: pending.length ? `需要继续处理 ${pending.length} 项未完成 DoD` : '需要读取当前项目状态并收集 DoD 证据',
    turnContract: {
      action: 'repair', targetDodItems, scope: [...(scope.inScope || [])], expectedResult: targetGoal,
    },
    instruction: workflow.autopilotMode === 'auto' ? appendHostedAgentContract(instruction) : instruction,
  };
}

function sanitizeSupervisorDecision(decision) {
  if (!decision || typeof decision !== 'object') throw new TypeError('decision is required');
  return {
    schemaVersion: String(decision.schemaVersion || '2.2'),
    decision: String(decision.decision || ''),
    reasonCode: String(decision.reasonCode || ''),
    summary: text(decision.summary),
    dodChecks: Array.isArray(decision.dodChecks) ? decision.dodChecks.map((item) => ({
      itemId: text(item.itemId, 100), status: text(item.status, 30), source: text(item.source, 200), description: text(item.description),
    })) : [],
    progress: decision.progress ? {
      state: text(decision.progress.state, 30), regression: decision.progress.regression === true,
      errorFingerprint: decision.progress.errorFingerprint || null,
    } : null,
    turnContract: decision.turnContract ? {
      action: text(decision.turnContract.action, 50),
      targetDodItems: Array.isArray(decision.turnContract.targetDodItems) ? decision.turnContract.targetDodItems.map((item) => text(item, 100)) : [],
      scope: Array.isArray(decision.turnContract.scope) ? decision.turnContract.scope.map((item) => text(item)) : [],
      expectedResult: text(decision.turnContract.expectedResult, 20_000),
    } : null,
    riskLevel: text(decision.riskLevel, 30),
    review: decision.review ? {
      source: text(decision.review.source, 30), provider: text(decision.review.provider, 50), model: text(decision.review.model, 200),
      decision: text(decision.review.decision, 30), summary: text(decision.review.summary, 1_000),
      dodChecks: Array.isArray(decision.review.dodChecks) ? decision.review.dodChecks.map((item) => ({
        index: Number.isInteger(item && item.index) ? item.index : -1,
        status: text(item && item.status, 20), reason: text(item && item.reason, 500),
      })).filter((item) => item.index >= 0 && ['pass', 'fail', 'pending'].includes(item.status)).slice(0, 30) : [],
    } : null,
    scopeCheck: decision.scopeCheck ? {
      withinGoal: decision.scopeCheck.withinGoal === true,
      withinScope: decision.scopeCheck.withinScope === true,
    } : null,
  };
}

module.exports = { applySupervisorReview, buildSupervisorDecision, sanitizeSupervisorDecision };
