'use strict';

const {
  discoverPrdCandidates,
  generatePrdNormalization,
  readPrdDocument,
} = require('./project-prd');

const TASK_KINDS = Object.freeze(['direct', 'light', 'standard', 'project', 'high_risk']);
const SOURCE_SELECTIONS = Object.freeze(['auto', 'user', 'none']);
const SENSITIVE_ASSIGNMENT = /(?:api[_ -]?key|authorization|bearer|oauth[_ -]?token|access[_ -]?token|refresh[_ -]?token|token|cookie|password|passwd|private[_ -]?key|prompt)\s*(?:=|:\s*bearer\s+|:\s*[^\s]{8,})/i;
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----/i;

function text(value, max = 2_000) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function redactText(value, max = 2_000) {
  const normalized = text(value, max);
  if (!normalized) return '';
  return normalized
    .replace(/((?:api[_ -]?key|oauth[_ -]?token|access[_ -]?token|refresh[_ -]?token|token|cookie|password|passwd|private[_ -]?key|prompt)\s*=\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/(authorization\s*:\s*bearer\s+)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi, '[REDACTED]');
}

function safeList(value, maxItems = 100, maxLength = 2_000) {
  if (!Array.isArray(value)) return [];
  const items = [];
  const seen = new Set();
  for (const item of value) {
    const normalized = text(item, maxLength);
    if (!normalized || SENSITIVE_ASSIGNMENT.test(normalized) || PRIVATE_KEY.test(normalized) || seen.has(normalized)) continue;
    seen.add(normalized);
    items.push(normalized);
    if (items.length >= maxItems) break;
  }
  return items;
}

function classifyTask({ goal = '', prd = null } = {}) {
  const value = text(goal, 20_000);
  const lower = value.toLowerCase();
  const highRiskSignals = [
    /(?:真实|自动|直接).{0,8}(?:发布|评论|回复|私信)/i,
    /(?:发布到|发送到).{0,12}(?:小红书|抖音|bilibili|公众号|视频号|生产环境)/i,
    /(?:删除|清空|drop|truncate).{0,12}(?:内容|数据|数据库|表|文件)/i,
    /(?:修改|写入).{0,8}(?:生产|线上).{0,8}(?:数据|数据库)/i,
    /(?:上传|读取|导出).{0,8}(?:敏感|密钥|api\s*key|token|cookie|密码)/i,
    /(?:项目范围之外|项目外|允许目录之外|越过允许)/i,
  ];
  if (highRiskSignals.some((pattern) => pattern.test(value))) {
    return { kind: 'high_risk', confidence: 0.98, reasons: ['检测到外部写入、删除、生产数据或敏感信息风险'], requiresPrd: false };
  }

  const projectSignals = [/(?:新项目|创建项目|多模块|多阶段|phase|mvp|架构|商业化|完整项目)/i, /\bprd\b/i];
  const subsystemCount = [/(?:web|前端|页面)/i, /(?:api|后端|服务端)/i, /(?:数据库|db|schema)/i, /(?:worker|队列|任务)/i]
    .filter((pattern) => pattern.test(value)).length;
  if (prd || projectSignals.some((pattern) => pattern.test(value)) || subsystemCount >= 3) {
    return { kind: 'project', confidence: prd ? 0.96 : 0.9, reasons: [prd ? '任务提供了 PRD' : '任务包含项目、多阶段或多个子系统信号'], requiresPrd: true };
  }

  const lightSignals = [/(?:按钮|颜色|文案|样式|间距|字号|图标)/i, /(?:一处|单个|简单|小型)/i];
  const changeSignal = /(?:修改|改成|调整|修复|替换|新增|删除)/i.test(value);
  if (changeSignal && lightSignals.some((pattern) => pattern.test(value))) {
    return { kind: 'light', confidence: 0.88, reasons: ['任务范围集中在单一、小型界面或文本修改'], requiresPrd: false };
  }

  const standardSignals = [/(?:修复|实现|增加|新增|修改).{0,12}(?:api|接口|功能|bug|测试|文件)/i, /(?:多个文件|单元测试|集成测试|typecheck|lint)/i];
  if (standardSignals.some((pattern) => pattern.test(value))) {
    return { kind: 'standard', confidence: 0.86, reasons: ['任务需要代码修改、接口或测试验证'], requiresPrd: false };
  }

  const directSignals = [/(?:等于多少|是什么|为什么|如何理解|解释|总结|翻译|概括)/i, /^\s*[\d\s()+\-*/.]+(?:等于多少)?[？?]?\s*$/i];
  if (directSignals.some((pattern) => pattern.test(value)) || (!changeSignal && /[？?]$/.test(lower))) {
    return { kind: 'direct', confidence: 0.94, reasons: ['任务是问答、解释或文本处理，不需要项目 Workflow'], requiresPrd: false };
  }

  return { kind: 'standard', confidence: 0.62, reasons: ['任务包含可执行目标但缺少足够信号进一步降级'], requiresPrd: false };
}

function normalizeSource(value = {}, selectedBy) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const selection = SOURCE_SELECTIONS.includes(selectedBy) ? selectedBy
    : SOURCE_SELECTIONS.includes(input.selectedBy) ? input.selectedBy : 'none';
  const hash = text(input.sha256, 64).toLowerCase();
  const modified = typeof input.modifiedAt === 'string' && !Number.isNaN(Date.parse(input.modifiedAt))
    ? new Date(input.modifiedAt).toISOString() : null;
  return {
    fileName: text(input.fileName, 300),
    version: text(input.version, 100),
    sha256: /^[a-f0-9]{64}$/.test(hash) ? hash : '',
    modifiedAt: modified,
    selectedBy: selection,
  };
}

function normalizeTaskContract(value = {}) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const rawClassification = input.classification && typeof input.classification === 'object' ? input.classification : {};
  const kind = TASK_KINDS.includes(rawClassification.kind) ? rawClassification.kind : 'standard';
  const confidence = Number(rawClassification.confidence);
  const classification = {
    kind,
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
    reasons: safeList(rawClassification.reasons, 12, 300),
    requiresPrd: rawClassification.requiresPrd === true,
  };
  const humanInput = input.humanGate && typeof input.humanGate === 'object' ? input.humanGate : {};
  const humanRequired = kind === 'high_risk' || humanInput.required === true;
  return {
    schemaVersion: 1,
    classification,
    runtimeContext: {
      projectPathSource: 'session',
      agentSource: 'session',
      sessionRefSource: 'session',
      settingsSource: 'persistent',
    },
    source: normalizeSource(input.source),
    goal: redactText(input.goal, 20_000),
    inScope: safeList(input.inScope),
    outOfScope: safeList(input.outOfScope),
    dod: safeList(input.dod),
    evidence: safeList(input.evidence),
    risks: safeList(input.risks),
    assumptions: safeList(input.assumptions),
    missingFields: safeList(input.missingFields, 30, 100),
    inferredFields: safeList(input.inferredFields, 30, 100),
    humanGate: {
      required: humanRequired,
      reason: humanRequired ? (text(humanInput.reason, 500) || '高风险任务必须等待人工审批') : '',
    },
  };
}

function buildTaskContract({ goal = '', prd = null, source = {}, selectedBy, aiDraft = null } = {}) {
  const explicitGoal = redactText(goal, 20_000);
  const parsed = prd && typeof prd === 'object' && !Array.isArray(prd) ? prd : {};
  const ai = aiDraft && typeof aiDraft === 'object' && !Array.isArray(aiDraft) ? aiDraft : {};
  const classification = classifyTask({ goal: explicitGoal || parsed.goals?.[0] || parsed.title || '', prd: prd || null });
  const inferredFields = [];
  const resolvedGoal = explicitGoal || text(parsed.goals?.[0], 20_000) || text(ai.goal, 20_000) || text(parsed.title, 20_000);
  if (!explicitGoal && resolvedGoal) inferredFields.push('goal');

  let inScope = safeList([...(parsed.inScope || []), ...(parsed.phases || []), ...(ai.inScope || [])]);
  let outOfScope = safeList([...(parsed.outOfScope || []), ...(parsed.constraints || []), ...(ai.outOfScope || [])]);
  let dod = safeList([...(parsed.dod || []), ...(ai.dod || [])]);
  let evidence = safeList([...(parsed.evidence || []), ...(parsed.tests || []), ...(parsed.acceptance || []), ...(ai.evidence || [])]);
  const risks = safeList([...(parsed.risks || []), ...(ai.risks || [])]);
  const assumptions = safeList(ai.assumptions || []);

  if (classification.kind === 'direct') {
    inScope = []; outOfScope = []; dod = []; evidence = [];
  } else if (classification.kind === 'light') {
    if (!dod.length) { dod = ['完成目标所述修改并通过相关检查']; inferredFields.push('dod'); }
    if (!evidence.length) { evidence = ['变更文件清单和相关检查结果']; inferredFields.push('evidence'); }
  } else if (classification.kind === 'standard') {
    if (!inScope.length && resolvedGoal) { inScope = [resolvedGoal]; inferredFields.push('inScope'); }
    if (!outOfScope.length) { outOfScope = ['不扩大用户明确目标以外的范围']; inferredFields.push('outOfScope'); }
    if (!dod.length) { dod = ['用户目标已完成并通过相关测试或检查']; inferredFields.push('dod'); }
    if (!evidence.length) { evidence = ['变更文件清单和测试、检查结果']; inferredFields.push('evidence'); }
  } else if (classification.kind === 'high_risk') {
    if (!inScope.length && resolvedGoal) { inScope = [resolvedGoal]; inferredFields.push('inScope'); }
  }

  const normalizedSource = normalizeSource(source, selectedBy || (source && source.selectedBy));
  const missingFields = [];
  const required = classification.kind === 'light' ? ['goal', 'dod', 'evidence']
    : classification.kind === 'standard' ? ['goal', 'inScope', 'outOfScope', 'dod', 'evidence']
      : classification.kind === 'project' ? ['source', 'goal', 'inScope', 'outOfScope', 'dod', 'evidence']
        : classification.kind === 'high_risk' ? ['goal', 'inScope', 'outOfScope', 'dod', 'evidence'] : ['goal'];
  const values = { goal: resolvedGoal, inScope, outOfScope, dod, evidence };
  for (const field of required) {
    if (field === 'source' ? !normalizedSource.fileName : !(Array.isArray(values[field]) ? values[field].length : values[field])) missingFields.push(field);
  }

  return normalizeTaskContract({
    schemaVersion: 1,
    classification,
    source: normalizedSource,
    goal: resolvedGoal,
    inScope,
    outOfScope,
    dod,
    evidence,
    risks: classification.kind === 'high_risk' && !risks.length ? ['任务包含需要人工确认的高风险操作'] : risks,
    assumptions,
    missingFields,
    inferredFields,
    humanGate: {
      required: classification.kind === 'high_risk',
      reason: classification.kind === 'high_risk' ? '检测到外部写入、删除、生产数据或敏感信息操作，必须等待人工审批' : '',
    },
  });
}

function intakeError(code, message, statusCode = 400, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  Object.assign(error, details);
  return error;
}

async function previewTaskIntake({
  projectPath,
  goal = '',
  prdMode = 'auto',
  prdPath = '',
  allowedRoots = [],
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  const mode = ['auto', 'current', 'manual', 'none'].includes(prdMode) ? prdMode : 'auto';
  const initialClassification = classifyTask({ goal });
  let candidates = [];
  let document = null;
  let warning = null;

  if (mode === 'manual') {
    if (!text(prdPath, 4_096)) throw intakeError('PRD_PATH_REQUIRED', '手动选择 PRD 时必须提供文件路径', 400);
    document = readPrdDocument({ projectPath, filePath: prdPath, allowedRoots, selectedBy: 'user' });
  } else if (mode !== 'none') {
    const shouldDiscover = mode === 'current' || initialClassification.requiresPrd;
    if (shouldDiscover) {
      candidates = discoverPrdCandidates({ projectPath, allowedRoots });
      const trusted = candidates.filter((item) => item.highConfidence);
      const selectable = trusted.length ? trusted : candidates;
      if (selectable.length > 1) {
        throw intakeError('PRD_SELECTION_REQUIRED', '发现多个 PRD 候选，请选择一个版本', 409, { candidates });
      }
      if (selectable.length === 1) {
        document = readPrdDocument({ projectPath, filePath: selectable[0].path, allowedRoots, selectedBy: 'auto' });
      } else if (mode === 'current') {
        throw intakeError('PRD_NOT_FOUND', '当前项目和允许的父级目录未找到 PRD', 404, { candidates: [] });
      } else if (initialClassification.requiresPrd) {
        warning = '未找到 PRD，已仅根据用户目标生成安全契约。';
      }
    }
  }

  let normalization = null;
  if (document) {
    normalization = await generatePrdNormalization({ document, env, fetchImpl });
    if (normalization.warning) warning = normalization.warning;
  }
  const contract = buildTaskContract({
    goal,
    prd: normalization && normalization.parsed,
    source: document ? document.source : {},
    selectedBy: document ? document.source.selectedBy : 'none',
    aiDraft: normalization && normalization.aiDraft,
  });
  if (!contract.goal) throw intakeError('TASK_GOAL_REQUIRED', '任务目标缺失，请输入目标或选择包含明确目标的 PRD', 422);
  return {
    taskContract: contract,
    candidates,
    normalizationSource: normalization ? normalization.source : 'none',
    warning,
  };
}

module.exports = {
  TASK_KINDS,
  buildTaskContract,
  classifyTask,
  normalizeTaskContract,
  previewTaskIntake,
};
