'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const RESEARCH_STATUSES = Object.freeze([
  'not_started', 'required', 'researching', 'completed', 'unresolved', 'permission_required',
  'timeout', 'budget_exceeded', 'conflict', 'failed',
]);
const RESEARCH_CODES = Object.freeze({
  TIMEOUT: 'RESEARCH_TIMEOUT',
  BUDGET_EXCEEDED: 'RESEARCH_BUDGET_EXCEEDED',
  SOURCE_LIMIT: 'RESEARCH_SOURCE_LIMIT',
  PERMISSION_REQUIRED: 'RESEARCH_PERMISSION_REQUIRED',
  CONFLICT: 'RESEARCH_CONFLICT',
  PROVIDER_UNAVAILABLE: 'RESEARCH_PROVIDER_UNAVAILABLE',
});
const DEFAULT_LIMITS = Object.freeze({
  maxResearchAttempts: 2,
  maxSources: 8,
  maxResearchRuntimeMs: 60_000,
  maxExternalPages: 5,
  maxLocalFiles: 12,
  maxSourceText: 1_000,
});
const SAFE_LOCAL_EXTENSIONS = new Set(['.md', '.mdx', '.txt']);
const SECRET_FILE = /^(?:\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx|kdbx))$/i;
const SENSITIVE = /((?:api[_ -]?key|authorization|bearer|oauth[_ -]?token|access[_ -]?token|refresh[_ -]?token|token|cookie|password|passwd|private[_ -]?key|prompt)\s*(?:=|:)\s*(?:bearer\s+)?)[^\s,;]+/gi;
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi;

function text(value, max = 2_000) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function redact(value, max = 2_000) {
  return text(value, max).replace(SENSITIVE, '$1[REDACTED]').replace(PRIVATE_KEY, '[REDACTED]');
}

function list(value, maxItems = 30, maxLength = 500) {
  const input = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/\r?\n/) : [];
  const output = [];
  const seen = new Set();
  for (const item of input) {
    const normalized = redact(item, maxLength).replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '');
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
    if (output.length >= maxItems) break;
  }
  return output;
}

function number(value, fallback, min, max) {
  return Number.isFinite(Number(value)) ? Math.max(min, Math.min(max, Number(value))) : fallback;
}

function boundedInteger(value, fallback, min, max) {
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

function confidenceLevel(value) {
  const confidence = number(value, 0, 0, 1);
  return confidence >= 0.8 ? 'high' : confidence >= 0.6 ? 'medium' : 'low';
}

function normalizeFields(value) {
  return [...new Set(list(value, 20, 80).map((field) => field.replace(/[^a-zA-Z0-9_]/g, '')).filter(Boolean))];
}

function safeUrl(value) {
  const raw = text(value, 2_048);
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return '';
    parsed.hash = '';
    parsed.search = '';
    return parsed.toString().slice(0, 2_048);
  } catch { return ''; }
}

function safeDomain(value) {
  const raw = text(value, 253).toLowerCase().replace(/^\*\./, '');
  if (!raw || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d+)?$/.test(raw)) return '';
  return raw;
}

function domainAllowed(url, allowedDomains = []) {
  const safe = safeUrl(url);
  if (!safe) return false;
  const hostname = new URL(safe).hostname.toLowerCase();
  return allowedDomains.some((item) => {
    const domain = safeDomain(item);
    return domain && (hostname === domain || hostname.endsWith(`.${domain}`));
  });
}

function hashContent(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function normalizeSource(value, kind = '') {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const sourceKind = ['local', 'external'].includes(input.kind) ? input.kind : kind;
  const result = { kind: sourceKind || 'local' };
  const title = redact(input.title || input.name, 300);
  const filePath = text(input.path || input.filePath, 2_000);
  const url = safeUrl(input.url || input.href);
  if (title) result.title = title;
  if (sourceKind === 'external') {
    if (!url) return null;
    result.url = url;
  } else if (filePath && !SECRET_FILE.test(path.basename(filePath))) {
    result.path = filePath;
  }
  const content = input.content || input.body || input.snippet;
  if (content) result.contentHash = hashContent(content);
  return result.path || result.url ? result : null;
}

function normalizeFindings(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const output = {};
  for (const field of ['goal', 'inScope', 'outOfScope', 'dod', 'evidence', 'risks', 'assumptions', 'requiredPermissions']) {
    const values = list(input[field], 20, 2_000);
    if (values.length) output[field] = values;
  }
  return output;
}

function normalizeResearchState(value = {}) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const status = RESEARCH_STATUSES.includes(input.status) ? input.status : 'not_started';
  const attempts = boundedInteger(input.attempts, 0, 0, 100);
  const confidence = number(input.confidence, 0, 0, 1);
  const sources = (Array.isArray(input.sources) ? input.sources : [])
    .map((source) => normalizeSource(source, source && source.kind)).filter(Boolean).slice(0, DEFAULT_LIMITS.maxSources);
  const result = {
    status, attempts, confidence, confidenceLevel: confidenceLevel(confidence),
    sources, findings: normalizeFindings(input.findings),
    assumptions: list(input.assumptions, 12, 500),
    unresolvedQuestions: list(input.unresolvedQuestions, 12, 500),
    needsHumanReason: redact(input.needsHumanReason, 500),
    errorCode: text(input.errorCode, 80).toUpperCase().replace(/[^A-Z0-9_]/g, '_'),
    updatedAt: Number.isFinite(input.updatedAt) && input.updatedAt >= 0 ? input.updatedAt : null,
  };
  if (!result.errorCode) delete result.errorCode;
  return result;
}

function safeResearchResult(value = {}) {
  const state = normalizeResearchState(value);
  return {
    ...state,
    status: state.status,
    sources: state.sources,
    findings: state.findings,
  };
}

function isInside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function defaultReadLocal({ projectPath, allowedRoots = [], maxFiles = DEFAULT_LIMITS.maxLocalFiles, maxBytes = 80_000 } = {}) {
  const root = path.resolve(String(projectPath || '').trim());
  if (!root) return { sources: [], findings: {}, unresolvedQuestions: [] };
  let project;
  try { project = fs.realpathSync.native(root); } catch { return { sources: [], findings: {}, unresolvedQuestions: [] }; }
  const roots = [project, ...allowedRoots.map((item) => {
    try { return fs.realpathSync.native(path.resolve(String(item || '').trim())); } catch { return null; }
  }).filter(Boolean)];
  const directories = [project, path.join(project, 'docs')];
  const files = [];
  for (const directory of directories) {
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isFile() || SECRET_FILE.test(entry.name) || !SAFE_LOCAL_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      const filePath = path.join(directory, entry.name);
      let realPath;
      let stat;
      try { realPath = fs.realpathSync.native(filePath); stat = fs.statSync(realPath); } catch { continue; }
      if (!stat.isFile() || stat.size > maxBytes || !roots.some((candidate) => isInside(realPath, candidate))) continue;
      files.push({ path: realPath, title: entry.name, kind: 'local' });
      if (files.length >= maxFiles) break;
    }
    if (files.length >= maxFiles) break;
  }
  const sources = [];
  for (const file of files) {
    try {
      const content = fs.readFileSync(file.path, 'utf8').slice(0, maxBytes);
      sources.push({ ...file, content });
    } catch { /* A missing document is not a reason to read outside the boundary. */ }
  }
  return { sources, findings: {}, unresolvedQuestions: [] };
}

function resultParts(value) {
  if (Array.isArray(value)) return { sources: value };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { sources: [] };
  return value;
}

function collectSources(value, kind) {
  const parts = resultParts(value);
  const candidates = Array.isArray(parts.sources) ? parts.sources : [parts];
  return candidates.map((source) => {
    const normalized = normalizeSource(source, kind);
    if (!normalized) return null;
    normalized._findings = normalizeFindings(source && source.findings);
    normalized._questions = list(source && (source.unresolvedQuestions || source.unresolved), 12, 500);
    return normalized;
  }).filter(Boolean);
}

function collectFindings(value) {
  const parts = resultParts(value);
  return normalizeFindings(parts.findings || parts.fact || {});
}

function collectQuestions(value) {
  const parts = resultParts(value);
  return list(parts.unresolvedQuestions || parts.unresolved, 12, 500);
}

function mergeFindings(target, value) {
  for (const [field, items] of Object.entries(value || {})) {
    if (!target[field]) target[field] = [];
    for (const item of items) if (!target[field].includes(item) && target[field].length < 20) target[field].push(item);
  }
  return target;
}

function hasConflict(items) {
  if (!Array.isArray(items) || items.length < 2) return false;
  const negative = items.some((item) => /(?:无需|不需要|禁止|不能|不可|不通过|不用)/i.test(item));
  const positive = items.some((item) => !/(?:无需|不需要|禁止|不能|不可|不通过|不用)/i.test(item));
  return negative && positive;
}

function createResearcher({
  readLocal = defaultReadLocal,
  searchExternal = null,
  fetchSource = null,
  now = () => Date.now(),
  limits = {},
} = {}) {
  const configured = { ...DEFAULT_LIMITS, ...(limits || {}) };
  const maxSources = boundedInteger(configured.maxSources, DEFAULT_LIMITS.maxSources, 1, 100);
  const maxExternalPages = boundedInteger(configured.maxExternalPages, DEFAULT_LIMITS.maxExternalPages, 0, 100);
  const maxResearchAttempts = boundedInteger(configured.maxResearchAttempts, DEFAULT_LIMITS.maxResearchAttempts, 1, 20);
  const maxResearchRuntimeMs = boundedInteger(configured.maxResearchRuntimeMs, DEFAULT_LIMITS.maxResearchRuntimeMs, 1_000, 86_400_000);
  const clock = () => (typeof now === 'function' ? now() : Date.now());

  async function research(request = {}) {
    const input = request && typeof request === 'object' && !Array.isArray(request) ? request : {};
    const startedAt = clock();
    const attempts = boundedInteger(input.attempts, 0, 0, 100) + 1;
    const base = {
      status: 'researching', attempts, confidence: 0, confidenceLevel: 'low', sources: [], findings: {},
      unresolvedQuestions: [], needsHumanReason: '', updatedAt: startedAt,
    };
    const finish = (value) => safeResearchResult({ ...base, ...value, attempts, updatedAt: clock() });
    const overRuntime = () => clock() - startedAt >= maxResearchRuntimeMs;
    if (attempts > maxResearchAttempts) return finish({ status: 'budget_exceeded', errorCode: RESEARCH_CODES.BUDGET_EXCEEDED });

    const fields = normalizeFields(input.fields);
    const findings = {};
    const sources = [];
    const unresolved = [];
    let localResult;
    try {
      localResult = await readLocal({
        projectPath: text(input.projectPath, 2_000), allowedRoots: list(input.allowedRoots, 20, 2_000),
        goal: redact(input.goal, 2_000), fields, maxFiles: configured.maxLocalFiles,
      });
    } catch {
      localResult = { sources: [], findings: {}, unresolvedQuestions: [] };
    }
    if (overRuntime()) return finish({ status: 'timeout', errorCode: RESEARCH_CODES.TIMEOUT });
    const localSources = collectSources(localResult, 'local');
    if (localSources.length > maxSources) return finish({ status: 'budget_exceeded', errorCode: RESEARCH_CODES.SOURCE_LIMIT });
    sources.push(...localSources);
    for (const source of localSources) {
      mergeFindings(findings, source._findings);
      unresolved.push(...source._questions);
    }
    mergeFindings(findings, collectFindings(localResult));
    unresolved.push(...collectQuestions(localResult));

    const requestedComplete = fields.length > 0 && fields.every((field) => Array.isArray(findings[field]) && findings[field].length);
    if (requestedComplete && !unresolved.length) {
      const conflictField = fields.find((field) => hasConflict(findings[field]));
      if (conflictField) return finish({ status: 'conflict', errorCode: RESEARCH_CODES.CONFLICT, sources, findings, unresolvedQuestions: [`字段 ${conflictField} 存在相互冲突的资料`] });
      return finish({ status: 'completed', confidence: sources.length ? 0.86 : 0.72, sources, findings });
    }

    const permission = input.permissionSnapshot && typeof input.permissionSnapshot === 'object' ? input.permissionSnapshot : {};
    const allowedDomains = list(permission.allowedResearchDomains, 20, 253).map(safeDomain).filter(Boolean);
    if (permission.researchRead !== true || !allowedDomains.length) {
      return finish({ status: 'permission_required', errorCode: RESEARCH_CODES.PERMISSION_REQUIRED, sources, findings, unresolvedQuestions: unresolved });
    }
    if (typeof searchExternal !== 'function') {
      return finish({ status: 'unresolved', errorCode: RESEARCH_CODES.PROVIDER_UNAVAILABLE, sources, findings, unresolvedQuestions: unresolved });
    }
    let searchResult;
    try {
      searchResult = await searchExternal({
        query: redact(`${text(input.goal, 1_000)} ${fields.join(' ')}`, 1_500),
        domains: [...allowedDomains], maxResults: Math.min(maxSources, maxExternalPages || maxSources),
      });
    } catch {
      return finish({ status: 'failed', errorCode: RESEARCH_CODES.PROVIDER_UNAVAILABLE, sources, findings, unresolvedQuestions: unresolved });
    }
    if (overRuntime()) return finish({ status: 'timeout', errorCode: RESEARCH_CODES.TIMEOUT, sources, findings, unresolvedQuestions: unresolved });
    const externalSources = collectSources(searchResult, 'external');
    if (sources.length + externalSources.length > maxSources || externalSources.length > maxExternalPages) {
      return finish({ status: 'budget_exceeded', errorCode: sources.length + externalSources.length > maxSources ? RESEARCH_CODES.SOURCE_LIMIT : RESEARCH_CODES.BUDGET_EXCEEDED, sources, findings, unresolvedQuestions: unresolved });
    }
    let fetched = 0;
    for (const source of externalSources) {
      if (!domainAllowed(source.url, allowedDomains)) continue;
      let fetchedValue = source;
      mergeFindings(findings, source._findings);
      unresolved.push(...source._questions);
      if (typeof fetchSource === 'function') {
        try { fetchedValue = await fetchSource({ ...source, findings: source._findings, url: safeUrl(source.url) }); } catch { fetchedValue = null; }
      }
      if (overRuntime()) return finish({ status: 'timeout', errorCode: RESEARCH_CODES.TIMEOUT, sources, findings, unresolvedQuestions: unresolved });
      fetched += 1;
      sources.push(source);
      mergeFindings(findings, collectFindings(fetchedValue));
      unresolved.push(...collectQuestions(fetchedValue));
      if (sources.length >= maxSources || fetched >= maxExternalPages) break;
    }
    if (externalSources.length && !fetched) {
      return finish({ status: 'permission_required', errorCode: RESEARCH_CODES.PERMISSION_REQUIRED, sources, findings, unresolvedQuestions: unresolved });
    }
    const conflictField = fields.find((field) => hasConflict(findings[field]));
    if (conflictField) return finish({ status: 'conflict', errorCode: RESEARCH_CODES.CONFLICT, sources, findings, unresolvedQuestions: [`字段 ${conflictField} 存在相互冲突的资料`] });
    const complete = fields.length > 0 && fields.every((field) => Array.isArray(findings[field]) && findings[field].length);
    return finish({ status: complete ? 'completed' : 'unresolved', confidence: complete ? 0.9 : 0.45, sources, findings, unresolvedQuestions: complete ? [] : unresolved });
  }

  return { research };
}

module.exports = {
  DEFAULT_LIMITS, RESEARCH_CODES, RESEARCH_STATUSES,
  createResearcher, normalizeResearchState, safeResearchResult,
};
