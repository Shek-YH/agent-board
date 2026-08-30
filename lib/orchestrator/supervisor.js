'use strict';

const crypto = require('node:crypto');

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

function buildSupervisorDecision({ workflow, progress } = {}) {
  if (!workflow || typeof workflow !== 'object') throw new TypeError('workflow is required');
  if (!progress || typeof progress !== 'object') throw new TypeError('progress is required');
  const contract = workflow.runContract || {};
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
    `继续完成目标：${text(contract.goal, 20_000)}`,
    `范围内：${(scope.inScope || []).join('；') || '仅处理 Run Contract 目标'}`,
    `范围外：${(scope.outOfScope || []).join('；') || '不扩展未声明的工作'}`,
    `当前未完成 DoD：${targetDescriptions.join('；')}`,
    '完成后请提供每项对应的可验证 Evidence，不要执行范围外操作。',
  ];
  return {
    ...base,
    decision: 'CONTINUE',
    reasonCode: evidence.some((item) => item.passed === false) ? 'DOD_ITEM_FAILED' : 'INITIAL_REVIEW',
    summary: pending.length ? `需要继续处理 ${pending.length} 项未完成 DoD` : '需要读取当前项目状态并收集 DoD 证据',
    turnContract: {
      action: 'repair', targetDodItems, scope: [...(scope.inScope || [])], expectedResult: text(contract.goal, 20_000),
    },
    instruction: lines.join('\n'),
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
    scopeCheck: decision.scopeCheck ? {
      withinGoal: decision.scopeCheck.withinGoal === true,
      withinScope: decision.scopeCheck.withinScope === true,
    } : null,
  };
}

module.exports = { buildSupervisorDecision, sanitizeSupervisorDecision };
