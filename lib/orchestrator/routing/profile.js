'use strict';

const { findModel, getSupportedReasoning } = require('./catalog');

const COMPLEXITY_TIERS = new Set(['C0', 'C1', 'C2', 'C3']);
const THINKING_TIERS = new Set(['T0', 'T1', 'T2', 'T3']);
const REASONING_ORDER = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const TARGET_REASONING = { T0: 'low', T1: 'medium', T2: 'high', T3: 'ultra' };

function normalizedTier(value, valid, fallback) {
  const tier = String(value || '').trim().toUpperCase();
  return valid.has(tier) ? tier : fallback;
}

function selectModel(catalog, modelOrder, complexityTier) {
  const candidates = [...new Set(Array.isArray(modelOrder) ? modelOrder : [])]
    .map((id) => findModel(catalog, id))
    .filter(Boolean);
  if (!candidates.length) return null;
  const complexityIndex = Number(complexityTier.slice(1));
  return candidates[Math.max(0, Math.min(candidates.length - 1, candidates.length - 1 - complexityIndex))];
}

function nearestReasoning(supported, target) {
  const levels = [...new Set(supported)].filter((level) => REASONING_ORDER.includes(level));
  if (!levels.length) return { level: null, fallbackApplied: false, fallbackReason: 'model has no supported reasoning levels' };
  if (levels.includes(target)) return { level: target, fallbackApplied: false, fallbackReason: null };
  const targetIndex = REASONING_ORDER.indexOf(target);
  const level = [...levels].sort((left, right) => {
    const leftDistance = Math.abs(REASONING_ORDER.indexOf(left) - targetIndex);
    const rightDistance = Math.abs(REASONING_ORDER.indexOf(right) - targetIndex);
    return leftDistance - rightDistance || REASONING_ORDER.indexOf(right) - REASONING_ORDER.indexOf(left);
  })[0];
  return {
    level,
    fallbackApplied: true,
    fallbackReason: `requested reasoning ${target} is unsupported; mapped to ${level}`,
  };
}

function resolveExecutionProfile({
  catalog, modelOrder, complexityTier = 'C1', thinkingTier = 'T1', promptPolicy = 'P1', manualPin = null,
} = {}) {
  const complexity = normalizedTier(complexityTier, COMPLEXITY_TIERS, 'C1');
  const thinking = normalizedTier(thinkingTier, THINKING_TIERS, 'T1');
  const selected = manualPin && manualPin.modelId
    ? findModel(catalog, manualPin.modelId)
    : selectModel(catalog, modelOrder, complexity);
  if (!selected) {
    return {
      modelId: null, reasoningLevel: null, complexityTier: complexity, thinkingTier: thinking,
      promptPolicy, fallbackApplied: false, fallbackReason: null, reasonCode: manualPin?.modelId ? 'MANUAL_PIN_UNAVAILABLE' : 'MODEL_UNAVAILABLE',
    };
  }

  const desired = manualPin && manualPin.reasoningLevel
    ? String(manualPin.reasoningLevel).trim().toLowerCase()
    : TARGET_REASONING[thinking];
  const reasoning = nearestReasoning(getSupportedReasoning(selected), desired);
  if (!reasoning.level) {
    return {
      modelId: selected.id, reasoningLevel: null, complexityTier: complexity, thinkingTier: thinking,
      promptPolicy, fallbackApplied: false, fallbackReason: reasoning.fallbackReason, reasonCode: 'REASONING_UNAVAILABLE',
    };
  }
  const result = {
    modelId: selected.id, reasoningLevel: reasoning.level, complexityTier: complexity, thinkingTier: thinking,
    promptPolicy, fallbackApplied: reasoning.fallbackApplied, fallbackReason: reasoning.fallbackReason, reasonCode: 'PROFILE_RESOLVED',
  };
  if (manualPin && manualPin.modelId) result.manualPin = true;
  return result;
}

module.exports = { COMPLEXITY_TIERS, THINKING_TIERS, resolveExecutionProfile };
