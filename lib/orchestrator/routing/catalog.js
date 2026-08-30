'use strict';

const REASONING_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function finiteOrNull(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function normalizeReasoning(value) {
  if (typeof value === 'string') return text(value).toLowerCase();
  if (!value || typeof value !== 'object') return '';
  return text(value.effort || value.level || value.reasoning_level || value.reasoningEffort).toLowerCase();
}

function normalizeModel(model) {
  if (!model || typeof model !== 'object') return null;
  const id = text(model.slug || model.id || model.model_id);
  if (!id) return null;
  const supportedReasoningLevels = [...new Set(
    (Array.isArray(model.supported_reasoning_levels)
      ? model.supported_reasoning_levels
      : Array.isArray(model.supportedReasoningEfforts) ? model.supportedReasoningEfforts : [])
      .map(normalizeReasoning)
      .filter((level) => REASONING_LEVELS.has(level)),
  )];
  const defaultReasoningLevel = normalizeReasoning(
    model.default_reasoning_level || model.default_reasoning_effort || model.defaultReasoningEffort,
  );
  return {
    id,
    displayName: text(model.display_name || model.displayName || model.name || model.model) || id,
    description: text(model.description),
    defaultReasoningLevel: REASONING_LEVELS.has(defaultReasoningLevel) ? defaultReasoningLevel : null,
    supportedReasoningLevels,
    visibility: text(model.visibility) || 'list',
    supportedInApi: model.supported_in_api !== false && model.supportedInApi !== false,
    contextWindow: finiteOrNull(model.context_window || model.contextWindow),
    maxContextWindow: finiteOrNull(model.max_context_window || model.maxContextWindow),
  };
}

function normalizeCatalogResponse(response, metadata = {}) {
  const payload = response && typeof response === 'object' ? response : {};
  const rawModels = Array.isArray(payload.models) ? payload.models : Array.isArray(payload.data) ? payload.data : [];
  const models = [];
  const seen = new Set();
  for (const raw of rawModels) {
    const model = normalizeModel(raw);
    if (!model || seen.has(model.id) || model.visibility !== 'list' || !model.supportedInApi) continue;
    seen.add(model.id);
    models.push(model);
  }
  return {
    source: text(metadata.source || payload.source) || 'native',
    fetchedAt: metadata.fetchedAt ?? payload.fetched_at ?? payload.fetchedAt ?? null,
    agentVersion: text(metadata.agentVersion || payload.agent_version || payload.agentVersion) || null,
    etag: text(metadata.etag || payload.etag) || null,
    models,
  };
}

function findModel(catalog, id, { includeHidden = false } = {}) {
  const target = text(id);
  if (!target || !catalog || !Array.isArray(catalog.models)) return null;
  return catalog.models.find((model) => model.id === target && (includeHidden || model.visibility === 'list')) || null;
}

function getSupportedReasoning(model) {
  return model && Array.isArray(model.supportedReasoningLevels) ? [...model.supportedReasoningLevels] : [];
}

function isCatalogFresh(catalog, now = Date.now(), ttlMs = 5 * 60 * 1000, agentVersion = null) {
  if (!catalog || !Array.isArray(catalog.models) || !Number.isFinite(Number(catalog.fetchedAt))) return false;
  if (agentVersion && catalog.agentVersion !== agentVersion) return false;
  return Number(now) - Number(catalog.fetchedAt) >= 0 && Number(now) - Number(catalog.fetchedAt) < Number(ttlMs);
}

module.exports = {
  REASONING_LEVELS,
  normalizeCatalogResponse,
  findModel,
  getSupportedReasoning,
  isCatalogFresh,
};
