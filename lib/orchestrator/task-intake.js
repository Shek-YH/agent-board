'use strict';

const {
  discoverPrdCandidates,
  generatePrdNormalization,
  generateTaskContractDraft,
  readPrdDocument,
} = require('./project-prd');
const { createResearcher, normalizeResearchState } = require('./researcher');

const TASK_KINDS = Object.freeze(['direct', 'light', 'standard', 'project', 'high_risk']);
const SOURCE_SELECTIONS = Object.freeze(['auto', 'user', 'none']);
const COMPLEXITIES = Object.freeze(['simple', 'standard', 'complex']);
const RISK_LEVELS = Object.freeze(['low', 'medium', 'high', 'critical']);
const GENERATION_SOURCES = Object.freeze(['user_goal', 'prd', 'model', 'safety_policy', 'inferred', 'user_edited', 'local_project_docs', 'external_reference', 'research']);
const GENERATION_STATUSES = Object.freeze(['draft', 'research_required', 'researching', 'ready', 'completed', 'needs_human', 'blocked']);
const RISK_RANK = Object.freeze({ low: 0, medium: 1, high: 2, critical: 3 });
const SENSITIVE_ASSIGNMENT = /(?:api[_ -]?key|authorization|bearer|oauth[_ -]?token|access[_ -]?token|refresh[_ -]?token|token|cookie|password|passwd|private[_ -]?key|prompt)\s*(?:=|:\s*bearer\s+|:\s*[^\s]{8,})/i;
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----/i;
// 真正的高风险安全边界：破坏性/不可逆/越权/凭据类操作。用于「用户已给出完整合同」时，
// 只对这些真实边界保留人机闸门，而不把「联网/权限/安装」这类日常操作误判为需人工确认。
const SAFETY_HIGH_RISK_AMBIGUITY = /(?:删除|清空|覆盖(?!点|率|范围|面|层|式|比|例)|生产|发布|部署|上线|git\s*push|项目目录之外|跨项目|密钥|token|密码|cookie|\.env|私钥|外部副作用|不可逆|数据库|数据文件|格式化|重置|账号|批量)/i;
const SAFETY_AMBIGUITY = /(?:权限|授权|审批|删除|清空|覆盖(?!点|率|范围|面|层|式|比|例)|生产|发布|部署|上线|网络|联网|安装|项目目录之外|跨项目|密钥|token|密码|cookie|\.env|私钥|外部副作用|不可逆|git\s*push)/i;
const DEFAULT_OUT_OF_SCOPE = Object.freeze([
  '不删除用户数据',
  '不覆盖用户数据',
  '不执行 Git Push',
  '不自动安装依赖',
  '不执行未授权网络访问',
  '不读取或输出密钥、Token、密码和完整 .env 内容',
  '不修改项目目录之外的文件',
  '不自动升级权限',
  '不执行无法验证结果的危险操作',
]);
const DEFAULT_ALLOWED_OPERATIONS = Object.freeze([
  '读取用户选择的项目目录相关文件',
  '修改项目目录内的源代码、测试和文档',
  '执行用户已预授权的测试或构建命令',
  '生成验证报告和 Run Receipt',
]);
const FIELD_LABELS = Object.freeze({
  goal: '任务目标', inScope: '范围内', outOfScope: '范围外', dod: '完成标准（DoD）',
  evidence: '验证证据', assumptions: '系统假设', requiredPermissions: '所需权限',
});

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

function listParts(value) {
  if (Array.isArray(value)) return value.flatMap((item) => typeof item === 'string' ? item.split(/\r?\n/) : []);
  return typeof value === 'string' ? value.split(/\r?\n/) : [];
}

function analysisText(value, max = 20_000) {
  return typeof value === 'string' ? value.replace(/\r\n?/g, '\n').trim().slice(0, max) : '';
}

function safeList(value, maxItems = 100, maxLength = 2_000) {
  const items = [];
  const seen = new Set();
  for (const item of listParts(value)) {
    const normalized = text(item, maxLength).replace(/^\s*(?:[-*•]\s+|\d+[.)]\s+)/, '').trim();
    if (!normalized || SENSITIVE_ASSIGNMENT.test(normalized) || PRIVATE_KEY.test(normalized) || seen.has(normalized)) continue;
    seen.add(normalized);
    items.push(normalized);
    if (items.length >= maxItems) break;
  }
  return items;
}

function highestRisk(current, next) {
  return RISK_RANK[next] > RISK_RANK[current] ? next : current;
}

function isNegatedRiskMatch(value, index) {
  const prefix = value.slice(Math.max(0, index - 80), index);
  if (/(?:^|[\n\r。；;，,、:：|\-])[-*•\s]*(?:不|不要|禁止|不得|不能|不可|无需|严禁|避免|拒绝|未授权|范围外|不允许)\s*(?:(?:自动|直接|执行|进行|读取|发送|安装|访问|使用|修改|提交|推送|上传|下载|联网|连接|调用|删除|清空|覆盖)\s*)*$/i.test(prefix)) return true;
  // “禁止部署和 Git Push”这类并列否定句中，第二个动作前会出现连接词。
  return /(?:^|[\n\r。；;，,、:：|\-])[-*•\s]*(?:不|不要|禁止|不得|不能|不可|无需|严禁|避免|拒绝|未授权|范围外|不允许)[^\n\r。；;:：]*?(?:和|或|、|,|，)\s*$/i.test(prefix);
}

function hasActiveRiskMatch(pattern, value) {
  const flags = `${pattern.flags.replace(/g/g, '')}g`;
  const matcher = new RegExp(pattern.source, flags);
  let match;
  while ((match = matcher.exec(value))) {
    if (!isNegatedRiskMatch(value, match.index)) return true;
    if (match[0] === '') matcher.lastIndex += 1;
  }
  return false;
}

function riskSignalText(value) {
  const lines = analysisText(value).split('\n');
  const signals = [];
  let skippedHeadingLevel = 0;
  let skipList = false;
  const policyHeading = /^\s*#{1,6}\s*(?:\d+(?:\.\d+)*[.)]?\s*)?(?:用户最终体验|默认安全边界|安全边界|权限和全自动|verified dispatch|必须补充的测试|错误提示|创建前保护|兼容性|风险因素|风险检查|输入参数|输出值|复杂度和风险判断|简单、复杂和高风险任务策略|高级编辑|PRD 同步更新要求|非谈判规则)/i;
  const policyMarker = /^\s*(?:必须遵守|默认安全边界|如果用户明确要求这些危险操作|以下情况必须进入\s*NEED_HUMAN|运行中不得(?:静默)?扩大权限|保持现有\s+verified dispatch|以下情况必须)/i;
  for (const line of lines) {
    const trimmed = line.trim();
    const heading = trimmed.match(/^(#{1,6})\s+/);
    if (heading) {
      const headingLevel = heading[1].length;
      if (skippedHeadingLevel && headingLevel > skippedHeadingLevel) continue;
      const skipSection = policyHeading.test(trimmed);
      skippedHeadingLevel = skipSection ? headingLevel : 0;
      skipList = false;
      if (!skipSection) signals.push(line);
      continue;
    }
    if (skippedHeadingLevel) continue;
    if (skipList) {
      if (!trimmed || /^(?:[-*•]|\d+[.)])\s+/.test(trimmed)) continue;
      skipList = false;
    }
    if (policyMarker.test(trimmed)) {
      skipList = true;
      continue;
    }
    signals.push(line);
  }
  return signals.join('\n');
}

function analyzeRisk(value) {
  const rules = [
    { level: 'critical', pattern: /(?:生产|线上).{0,20}(?:删除|清空|覆盖|drop|truncate|迁移)/i, reason: '任务涉及生产数据的删除、覆盖或迁移', permission: '删除或覆盖用户数据' },
    { level: 'critical', pattern: /(?:读取|导出|上传|发送).{0,16}(?:密钥|token|令牌|密码|cookie|完整\s*\.env|私钥)/i, reason: '任务涉及密钥、Token、密码或完整 .env', permission: '读取敏感信息' },
    { level: 'high', pattern: /(?:删除|清空|覆盖|drop|truncate|迁移|清理).{0,20}(?:数据|数据库|表|文件|目录|内容)/i, reason: '任务包含删除、覆盖、迁移或清理操作', permission: '删除或覆盖用户数据' },
    { level: 'high', pattern: /(?:网络|联网|http|https|请求接口|抓取|下载|上传)/i, reason: '任务需要网络访问', permission: '访问网络' },
    { level: 'high', pattern: /(?:安装|npm\s+install|pnpm\s+add|yarn\s+add|pip\s+install).{0,20}(?:依赖|包|插件)?/i, reason: '任务需要安装依赖或软件包', permission: '安装依赖' },
    { level: 'high', pattern: /(?:git\s+push|推送|提交并推送|部署|发布到|上线|生产环境)/i, reason: '任务包含 Git Push、部署或外部发布', permission: 'Git Push、部署或发布' },
    { level: 'high', pattern: /(?:小红书|抖音|bilibili|公众号|视频号|评论|回复|私信|外部消息|真实发布)/i, reason: '任务包含外部不可逆副作用或消息发送', permission: '外部发布或消息发送' },
    { level: 'high', pattern: /(?:项目范围之外|项目外|允许目录之外|越过允许|跨项目|其他项目目录)/i, reason: '任务可能访问项目目录之外', permission: '访问项目目录之外' },
    { level: 'high', pattern: /(?:扩大权限|自动授权|绕过审批|跳过确认|无法验证|不需要验证)/i, reason: '任务要求扩大权限或执行无法验证的操作', permission: '扩大权限或执行无法验证操作' },
    { level: 'medium', pattern: /(?:数据库|迁移|用户数据|(?:修改|写入|变更|调整|导出|删除|清理|管理).{0,12}(?:配置|权限)|(?:修改|变更|迁移|删除|清理).{0,12}schema)/i, reason: '任务涉及数据、配置或权限边界', permission: '' },
  ];
  let riskLevel = 'low';
  const riskReasons = [];
  const requiredPermissions = [];
  const signals = riskSignalText(value);
  for (const rule of rules) {
    if (!hasActiveRiskMatch(rule.pattern, signals)) continue;
    riskLevel = highestRisk(riskLevel, rule.level);
    if (!riskReasons.includes(rule.reason)) riskReasons.push(rule.reason);
    if (rule.permission && !requiredPermissions.includes(rule.permission)) requiredPermissions.push(rule.permission);
  }
  return { riskLevel, riskReasons, requiredPermissions };
}

function classifyComplexity(value, { kind, subsystemCount } = {}) {
  if (!value) return 'simple';
  const lines = safeList(value, 30, 1_000).length;
  const subgoals = (value.match(/(?:并且|同时|以及|还要|另外|分为|阶段)/gi) || []).length;
  const codeSignals = /(?:修改|实现|修复|新增|重构|代码|文件|测试|构建|lint|typecheck|接口|数据库|配置)/i.test(value) ? 1 : 0;
  const collaborationSignals = /(?:多轮|多阶段|多个 Agent|协同|完整项目|mvp|架构|迁移)/i.test(value) ? 2 : 0;
  const score = (kind === 'project' ? 4 : 0) + Math.max(0, lines - 1) + subgoals + subsystemCount + codeSignals + collaborationSignals;
  if (score >= 5) return 'complex';
  if (score >= 2) return 'standard';
  return 'simple';
}

function classifyTask({ goal = '', prd = null } = {}) {
  const value = analysisText(goal);
  const lower = value.toLowerCase();
  const risk = analyzeRisk(value);
  const subsystemCount = [/(?:web|前端|页面|ui)/i, /(?:api|后端|服务端)/i, /(?:数据库|db|schema)/i, /(?:worker|队列|任务)/i]
    .filter((pattern) => pattern.test(value)).length;
  const projectSignals = [/(?:新项目|创建项目|多模块|多阶段|phase|mvp|架构|商业化|完整项目)/i, /\bprd\b/i];
  const isProject = Boolean(prd) || projectSignals.some((pattern) => pattern.test(value)) || subsystemCount >= 3;
  const changeSignal = /(?:修改|改成|调整|修复|替换|新增|删除|实现|创建|重构)/i.test(value);
  let kind;
  let confidence;
  let reasons;
  let requiresPrd = false;
  if (RISK_RANK[risk.riskLevel] >= RISK_RANK.high) {
    kind = 'high_risk'; confidence = 0.98; reasons = ['检测到需要人工确认的高风险操作'];
  } else if (isProject) {
    kind = 'project'; confidence = prd ? 0.96 : 0.9;
    reasons = [prd ? '任务提供了 PRD' : '任务包含项目、多阶段或多个子系统信号']; requiresPrd = true;
  } else {
    const lightSignals = [/(?:按钮|颜色|文案|样式|间距|字号|图标)/i, /(?:一处|单个|简单|小型)/i];
    const standardSignals = [/(?:修复|实现|增加|新增|修改).{0,12}(?:api|接口|功能|bug|测试|文件)/i, /(?:多个文件|单元测试|集成测试|typecheck|lint)/i, /(?:继续|根据目标|按要求).{0,12}(?:任务|旧|项目)/i];
    const directSignals = [/(?:等于多少|是什么|为什么|如何理解|解释|总结|翻译|概括)/i, /^\s*[\d\s()+\-*/.]+(?:等于多少)?[？?]?\s*$/i];
    if (changeSignal && lightSignals.some((pattern) => pattern.test(value))) {
      kind = 'light'; confidence = 0.88; reasons = ['任务范围集中在单一、小型界面或文本修改'];
    } else if (standardSignals.some((pattern) => pattern.test(value))) {
      kind = 'standard'; confidence = 0.86; reasons = ['任务需要代码修改、接口或测试验证'];
    } else if (directSignals.some((pattern) => pattern.test(value)) || (!changeSignal && /[？?]$/.test(lower))) {
      kind = 'direct'; confidence = 0.94; reasons = ['任务是问答、解释或文本处理，不需要项目 Workflow'];
    } else {
      kind = 'standard'; confidence = 0.62; reasons = ['任务包含可执行目标但缺少足够信号进一步降级'];
    }
  }
  const complexity = classifyComplexity(value, { kind, subsystemCount });
  return {
    kind, complexity, riskLevel: risk.riskLevel, riskReasons: risk.riskReasons,
    requiredPermissions: risk.requiredPermissions, confidence, reasons, requiresPrd,
  };
}

function normalizeSource(value = {}, selectedBy) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const selection = SOURCE_SELECTIONS.includes(selectedBy) ? selectedBy
    : SOURCE_SELECTIONS.includes(input.selectedBy) ? input.selectedBy : 'none';
  const hash = text(input.sha256, 64).toLowerCase();
  const modified = typeof input.modifiedAt === 'string' && !Number.isNaN(Date.parse(input.modifiedAt))
    ? new Date(input.modifiedAt).toISOString() : null;
  return {
    fileName: text(input.fileName, 300), version: text(input.version, 100),
    sha256: /^[a-f0-9]{64}$/.test(hash) ? hash : '', modifiedAt: modified, selectedBy: selection,
  };
}

function sourceMap(value = {}) {
  const output = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return output;
  for (const [field, source] of Object.entries(value)) {
    if (GENERATION_SOURCES.includes(source)) output[field] = source;
  }
  return output;
}

function defaultComplexity(kind) {
  return kind === 'project' ? 'complex' : ['direct', 'light'].includes(kind) ? 'simple' : 'standard';
}

function fieldLabels(fields) {
  return safeList(fields, 30, 100).map((field) => FIELD_LABELS[field] || field);
}

function confidenceLevel(value) {
  const confidence = Number(value);
  return Number.isFinite(confidence) && confidence >= 0.8 ? 'high' : Number.isFinite(confidence) && confidence >= 0.6 ? 'medium' : 'low';
}

function normalizeTaskContract(value = {}) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const rawClassification = input.classification && typeof input.classification === 'object' ? input.classification : {};
  const kind = TASK_KINDS.includes(rawClassification.kind) ? rawClassification.kind : 'standard';
  const confidence = Number(rawClassification.confidence);
  const riskLevel = RISK_LEVELS.includes(rawClassification.riskLevel)
    ? rawClassification.riskLevel : kind === 'high_risk' ? 'high' : 'low';
  const classification = {
    kind,
    complexity: COMPLEXITIES.includes(rawClassification.complexity) ? rawClassification.complexity : defaultComplexity(kind),
    riskLevel,
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
    reasons: safeList(rawClassification.reasons, 12, 300),
    riskReasons: safeList(rawClassification.riskReasons, 12, 300),
    requiresPrd: rawClassification.requiresPrd === true,
  };
  const humanInput = input.humanGate && typeof input.humanGate === 'object' ? input.humanGate : {};
  const needsHumanReason = text(input.needsHumanReason, 500);
  const runtimeInput = input.runtimeContext && typeof input.runtimeContext === 'object' && !Array.isArray(input.runtimeContext)
    ? input.runtimeContext : {};
  const runtimeContext = {
    projectPathSource: ['project', 'session'].includes(runtimeInput.projectPathSource) ? runtimeInput.projectPathSource : 'session',
    agentSource: ['client', 'session'].includes(runtimeInput.agentSource) ? runtimeInput.agentSource : 'session',
    sessionRefSource: ['none', 'client', 'session'].includes(runtimeInput.sessionRefSource) ? runtimeInput.sessionRefSource : 'session',
    settingsSource: 'persistent',
  };
  const missingFields = safeList(input.missingFields, 30, 100);
  const generationSources = sourceMap(input.generationSources);
  const research = normalizeResearchState(input.research || input.researchState);
  const contractConfidence = Number(input.confidence);
  const confidenceValue = Number.isFinite(contractConfidence) ? Math.max(0, Math.min(1, contractConfidence)) : classification.confidence;
  const researchableFields = safeList(input.researchableFields, 20, 100);
  const humanRequiredFields = safeList(input.humanRequiredFields, 20, 100);
  const generationStatus = GENERATION_STATUSES.includes(input.generationStatus)
    ? input.generationStatus
    : humanRequiredFields.length || needsHumanReason || kind === 'high_risk' ? 'needs_human'
      : research.status === 'completed' && confidenceValue >= 0.7 ? 'ready'
        : confidenceValue < 0.7 || researchableFields.length ? 'research_required' : 'draft';
  const actualHumanRequired = kind === 'high_risk' || humanInput.required === true || Boolean(needsHumanReason) || humanRequiredFields.length > 0;
  return {
    schemaVersion: 1,
    classification,
    runtimeContext,
    source: normalizeSource(input.source),
    sourceSummary: text(input.sourceSummary) || (input.source?.fileName ? 'prd' : 'goal-only'),
    goal: redactText(input.goal, 20_000),
    goalSummary: redactText(input.goalSummary, 2_000),
    inScope: safeList(input.inScope), outOfScope: safeList(input.outOfScope),
    dod: safeList(input.dod), evidence: safeList(input.evidence), risks: safeList(input.risks),
    assumptions: safeList(input.assumptions), requiredPermissions: safeList(input.requiredPermissions),
    allowedOperations: safeList(input.allowedOperations, 30, 300),
    blockedOperations: safeList(input.blockedOperations, 30, 300),
    missingFields,
    missingFieldLabels: fieldLabels(input.missingFieldLabels || missingFields),
    inferredFields: safeList(input.inferredFields, 30, 100),
    generationSources,
    generationStatus,
    confidence: confidenceValue,
    confidenceLevel: confidenceLevel(confidenceValue),
    research,
    unresolvedQuestions: safeList(input.unresolvedQuestions, 12, 500),
    researchableFields,
    humanRequiredFields,
    requiresHumanConfirmation: input.requiresHumanConfirmation !== false,
    needsHumanReason,
    humanGate: {
      required: actualHumanRequired,
      state: ['NEED_HUMAN', 'APPROVAL_REQUIRED'].includes(humanInput.state) ? humanInput.state : actualHumanRequired ? 'APPROVAL_REQUIRED' : '',
      reason: actualHumanRequired ? (text(humanInput.reason, 500) || needsHumanReason || '高风险任务必须等待人工审批') : '',
    },
  };
}

function goalScopeItems(goal) {
  const items = safeList(goal, 20, 2_000);
  return items.length ? items : [];
}

function explicitGoalItems(goal, pattern) {
  return safeList(goal, 20, 2_000).filter((item) => pattern.test(item));
}

function buildTaskContract({ goal = '', prd = null, source = {}, selectedBy, aiDraft = null, runtimeContext, autoGenerate = false } = {}) {
  const explicitGoal = redactText(goal, 20_000);
  const parsed = prd && typeof prd === 'object' && !Array.isArray(prd) ? prd : {};
  const ai = aiDraft && typeof aiDraft === 'object' && !Array.isArray(aiDraft) ? aiDraft : {};
  const goalSummary = text(ai.goalSummary, 2_000);
  const classification = classifyTask({ goal: goal || parsed.goals?.[0] || parsed.title || '', prd: prd || null });
  const inferredFields = [];
  const resolvedGoal = explicitGoal || text(parsed.goals?.[0], 20_000) || text(ai.goal, 20_000) || text(parsed.title, 20_000);
  if (!explicitGoal && resolvedGoal) inferredFields.push('goal');

  const prdInScope = safeList([parsed.inScope, parsed.phases].flat());
  const aiInScope = safeList(ai.inScope);
  const prdOutOfScope = safeList([parsed.outOfScope, parsed.constraints].flat());
  const aiOutOfScope = safeList(ai.outOfScope);
  const prdDod = safeList(parsed.dod);
  const aiDod = safeList(ai.dod);
  const prdEvidence = safeList([parsed.evidence, parsed.tests, parsed.acceptance].flat());
  const aiEvidence = safeList(ai.evidence);
  const parsedInScope = safeList([...prdInScope, ...aiInScope]);
  const parsedOutOfScope = safeList([...prdOutOfScope, ...aiOutOfScope]);
  const parsedDod = safeList([...prdDod, ...aiDod]);
  const parsedEvidence = safeList([...prdEvidence, ...aiEvidence]);
  const parsedRisks = safeList([parsed.risks, ai.risks].flat());
  const parsedAssumptions = safeList([parsed.assumptions, ai.assumptions].flat());
  const normalizedSource = normalizeSource(source, selectedBy || (source && source.selectedBy));
  const generatedSources = {};
  if (explicitGoal) generatedSources.goal = 'user_goal';
  else if (resolvedGoal && (parsed.goals?.length || parsed.title)) generatedSources.goal = 'prd';
  else if (resolvedGoal) generatedSources.goal = 'inferred';
  let inScope = parsedInScope;
  let outOfScope = parsedOutOfScope;
  let dod = parsedDod;
  let evidence = parsedEvidence;
  // 调用方已把 inScope+dod+evidence 都写全：完整合同不应再因 LLM 置信度低而被强制
  // 置入只读研究（否则空项目/路径脱敏项目上的托管任务永远无法派发第 1 轮）。
  const userProvidedFull = parsedInScope.length > 0 && parsedDod.length > 0 && parsedEvidence.length > 0;
  let risks = parsedRisks;
  let assumptions = parsedAssumptions;
  let requiredPermissions = [...classification.requiredPermissions];
  let needsHumanReason = '';
  const researchableFields = [];
  const humanRequiredFields = [];

  if (autoGenerate) {
    const vagueGoal = !resolvedGoal
      || /^(?:完成目标|达到预期|尽快处理|修一下|做完它|实现需求)[。！!？?]?$/i.test(resolvedGoal)
      || (/完成目标/.test(resolvedGoal) && !/(?:修改|实现|修复|新增|删除|创建|构建|测试|页面|接口|文件|数据)/i.test(resolvedGoal));
    if (!inScope.length && !vagueGoal) { inScope = goalScopeItems(explicitGoal || resolvedGoal); generatedSources.inScope = explicitGoal ? 'user_goal' : 'inferred'; inferredFields.push('inScope'); }
    if (!outOfScope.length) generatedSources.outOfScope = 'safety_policy';
    outOfScope = safeList([...outOfScope, ...DEFAULT_OUT_OF_SCOPE]);
    if (!dod.length && !vagueGoal) {
      dod = explicitGoalItems(explicitGoal, /(?:验收|完成标准|dod|必须|通过测试|测试通过|可验证)/i);
      if (dod.length) generatedSources.dod = 'user_goal';
      else { dod = ['完成用户目标所述变更，并通过相关测试或检查']; generatedSources.dod = 'inferred'; }
      inferredFields.push('dod');
    }
    if (!evidence.length && !vagueGoal) {
      evidence = explicitGoalItems(explicitGoal, /(?:node\s+--test|npm\s+test|测试命令|构建命令|检查结果|截图|返回值|状态验证|receipt)/i);
      if (evidence.length) generatedSources.evidence = 'user_goal';
      else { evidence = ['变更文件清单和相关测试、检查结果']; generatedSources.evidence = 'inferred'; }
      inferredFields.push('evidence');
    }
    if (!assumptions.length) {
      assumptions = ['仅在用户选择的项目目录内工作', '项目上下文已通过存在、可读写和 Git 状态校验'];
      if (!normalizedSource.fileName) assumptions.push('本合同仅根据任务目标生成，未读取 PRD');
      generatedSources.assumptions = 'inferred'; inferredFields.push('assumptions');
    }
    if (prdInScope.length) generatedSources.inScope = 'prd';
    if (aiInScope.length && !prdInScope.length) generatedSources.inScope = 'model';
    if (prdOutOfScope.length) generatedSources.outOfScope = 'prd';
    if (aiOutOfScope.length && !prdOutOfScope.length) generatedSources.outOfScope = 'model';
    if (prdDod.length) generatedSources.dod = 'prd';
    if (aiDod.length && !prdDod.length) generatedSources.dod = 'model';
    if (prdEvidence.length) generatedSources.evidence = 'prd';
    if (aiEvidence.length && !prdEvidence.length) generatedSources.evidence = 'model';
    if (vagueGoal) {
      if (!inScope.length && resolvedGoal) {
        inScope = [resolvedGoal]; generatedSources.inScope = explicitGoal ? 'user_goal' : 'inferred'; inferredFields.push('inScope');
      }
      if (!dod.length && resolvedGoal) {
        dod = ['完成任务目标，并通过相关测试或检查']; generatedSources.dod = explicitGoal ? 'user_goal' : 'inferred'; inferredFields.push('dod');
      }
      if (!evidence.length && resolvedGoal) {
        evidence = ['变更文件清单和测试、检查结果']; generatedSources.evidence = explicitGoal ? 'user_goal' : 'inferred'; inferredFields.push('evidence');
      }
      for (const field of ['inScope', 'dod', 'evidence']) if (!researchableFields.includes(field)) researchableFields.push(field);
    }
    if (classification.confidence < 0.7 && !userProvidedFull) {
      for (const field of ['inScope', 'dod', 'evidence']) if (!researchableFields.includes(field)) researchableFields.push(field);
    }
    const ambiguities = safeList(ai.ambiguities, 8, 500);
    const materialAmbiguities = ambiguities.filter((item) => SAFETY_AMBIGUITY.test(item));
    if (materialAmbiguities.length && !needsHumanReason) {
      const highRiskBoundary = materialAmbiguities.some((item) => SAFETY_HIGH_RISK_AMBIGUITY.test(item));
      if (!userProvidedFull || highRiskBoundary) {
        needsHumanReason = `AI 识别到需要确认的安全边界：${materialAmbiguities.join('；')}`;
        humanRequiredFields.push('safetyBoundary');
      }
    }
  } else if (classification.kind === 'direct') {
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

  if (classification.kind === 'high_risk' && !risks.length) risks = classification.riskReasons.length ? classification.riskReasons : ['任务包含需要人工确认的高风险操作'];
  if (!resolvedGoal) humanRequiredFields.push('goal');
  const missingFields = [];
  const required = autoGenerate
    ? ['goal', 'inScope', 'outOfScope', 'dod', 'evidence']
    : classification.kind === 'light' ? ['goal', 'dod', 'evidence']
      : classification.kind === 'standard' ? ['goal', 'inScope', 'outOfScope', 'dod', 'evidence']
        : classification.kind === 'project' ? ['source', 'goal', 'inScope', 'outOfScope', 'dod', 'evidence']
          : classification.kind === 'high_risk' ? ['goal', 'inScope', 'outOfScope', 'dod', 'evidence'] : ['goal'];
  const values = { goal: resolvedGoal, inScope, outOfScope, dod, evidence };
  for (const field of required) {
    if (field === 'source' ? !normalizedSource.fileName : !(Array.isArray(values[field]) ? values[field].length : values[field])) missingFields.push(field);
  }
  const hasModelDraft = Boolean(Object.keys(ai).length);
  const sourceSummary = normalizedSource.fileName
    ? (hasModelDraft ? (explicitGoal ? 'goal+prd+model+safety' : 'prd+model+safety') : (explicitGoal ? 'goal+prd+safety' : 'prd+safety'))
    : (hasModelDraft ? 'goal+model+safety' : 'goal-only');
  return normalizeTaskContract({
    schemaVersion: 1, runtimeContext, classification, source: normalizedSource, sourceSummary,
    goal: resolvedGoal, goalSummary, inScope, outOfScope, dod, evidence, risks, assumptions, requiredPermissions,
    allowedOperations: DEFAULT_ALLOWED_OPERATIONS, blockedOperations: DEFAULT_OUT_OF_SCOPE,
    missingFields, inferredFields, generationSources: generatedSources,
    generationStatus: needsHumanReason || humanRequiredFields.length ? 'needs_human'
      : researchableFields.length || (classification.confidence < 0.7 && !userProvidedFull) ? 'research_required' : 'ready',
    confidence: classification.confidence,
    research: { status: researchableFields.length || (classification.confidence < 0.7 && !userProvidedFull) ? 'required' : 'not_started' },
    researchableFields, humanRequiredFields,
    needsHumanReason,
    requiresHumanConfirmation: true,
    humanGate: {
      required: classification.riskLevel === 'high' || classification.riskLevel === 'critical',
      state: needsHumanReason || humanRequiredFields.length ? 'NEED_HUMAN' : classification.riskLevel === 'high' || classification.riskLevel === 'critical' ? 'APPROVAL_REQUIRED' : '',
      reason: classification.riskLevel === 'high' || classification.riskLevel === 'critical'
        ? '检测到外部写入、删除、生产数据或敏感信息操作，必须等待人工审批' : '',
    },
  });
}

function mergeTaskContractInputs(primary, fallback) {
  const candidate = primary && typeof primary === 'object' && !Array.isArray(primary) ? primary : {};
  const base = fallback && typeof fallback === 'object' && !Array.isArray(fallback) ? fallback : {};
  const merged = {
    ...base,
    ...candidate,
    classification: { ...(base.classification || {}), ...(candidate.classification || {}) },
    source: { ...(base.source || {}), ...(candidate.source || {}) },
    runtimeContext: { ...(base.runtimeContext || {}), ...(candidate.runtimeContext || {}) },
    humanGate: { ...(base.humanGate || {}), ...(candidate.humanGate || {}) },
    generationSources: { ...(base.generationSources || {}), ...(candidate.generationSources || {}) },
    research: { ...(base.research || {}), ...(candidate.research || {}) },
  };
  if (!text(candidate.goal) && text(base.goal)) merged.goal = base.goal;
  if (!text(candidate.source?.fileName) && text(base.source?.fileName)) merged.source = { ...base.source };
  for (const field of ['inScope', 'outOfScope', 'dod', 'evidence', 'risks', 'assumptions', 'requiredPermissions']) {
    if ((!Array.isArray(candidate[field]) || candidate[field].length === 0) && Array.isArray(base[field]) && base[field].length) {
      merged[field] = base[field];
    }
  }
  return merged;
}

function autoCompleteTaskContract({ contract, fallback = null } = {}) {
  const normalized = normalizeTaskContract(mergeTaskContractInputs(contract, fallback));
  const generationSources = { ...normalized.generationSources };
  const inferredFields = [...normalized.inferredFields];
  let inScope = normalized.inScope;
  let outOfScope = normalized.outOfScope;
  let dod = normalized.dod;
  let evidence = normalized.evidence;
  let needsHumanReason = normalized.needsHumanReason;
  const researchableFields = [...normalized.researchableFields];
  // 调用方已把 inScope+dod+evidence 都写全：完整合同不应再因 LLM 置信度低而被强制
  // 置入只读研究（否则空项目/路径脱敏项目上的托管任务永远无法派发第 1 轮）。
  const userProvidedFull = normalized.inScope.length > 0 && normalized.dod.length > 0 && normalized.evidence.length > 0;
  if (normalized.goal && !inScope.length) {
    inScope = [normalized.goal]; generationSources.inScope = 'inferred'; inferredFields.push('inScope');
  }
  if (!outOfScope.length) {
    outOfScope = [...DEFAULT_OUT_OF_SCOPE]; generationSources.outOfScope = 'safety_policy'; inferredFields.push('outOfScope');
  }
  if (normalized.goal && !dod.length) {
    dod = ['完成任务目标，并通过相关测试或检查']; generationSources.dod = 'inferred'; inferredFields.push('dod');
  }
  if (normalized.goal && !evidence.length) {
    evidence = ['变更文件清单和测试、检查结果']; generationSources.evidence = 'inferred'; inferredFields.push('evidence');
  }
  if (normalized.classification.confidence < 0.7 && !userProvidedFull) {
    for (const field of ['inScope', 'dod', 'evidence']) if (!researchableFields.includes(field)) researchableFields.push(field);
  }
  const researchRequired = researchableFields.length > 0;
  const currentResearchStatus = normalized.research.status;
  const nextResearchStatus = researchRequired
    ? (['permission_required', 'conflict', 'timeout', 'budget_exceeded', 'failed'].includes(currentResearchStatus)
      ? currentResearchStatus : 'required')
    : (userProvidedFull ? 'not_started' : currentResearchStatus);
  return normalizeTaskContract({
    ...normalized,
    inScope, outOfScope, dod, evidence,
    generationSources, inferredFields, needsHumanReason, researchableFields,
    generationStatus: needsHumanReason ? 'needs_human' : researchRequired ? 'research_required' : normalized.generationStatus,
    research: { ...normalized.research, status: nextResearchStatus },
    humanGate: {
      ...normalized.humanGate,
      required: normalized.humanGate.required,
      state: needsHumanReason ? 'NEED_HUMAN' : normalized.humanGate.state,
      reason: needsHumanReason || normalized.humanGate.reason,
    },
  });
}

function isVerifiableDod(items) {
  return items.some((item) => /(?:测试|检查|验证|通过|已完成|结果|构建|lint|typecheck|接口|页面|文件|命令|返回|状态|验收|可复现|截图|receipt|test|build)/i.test(item));
}

function isVerifiableEvidence(items) {
  return items.some((item) => /(?:测试|检查|验证|命令|构建|返回|状态|文件|receipt|日志|截图|test|build|diff|git|结果)/i.test(item));
}

function validateTaskContract({ contract, permissionSnapshot = null } = {}) {
  const normalized = normalizeTaskContract(contract);
  const missingFields = [];
  const reasons = [];
  const addMissing = (field, reason) => { if (!missingFields.includes(field)) missingFields.push(field); if (reason && !reasons.includes(reason)) reasons.push(reason); };
  const rawSources = contract && typeof contract === 'object' && !Array.isArray(contract)
    && contract.generationSources && typeof contract.generationSources === 'object' && !Array.isArray(contract.generationSources)
    ? contract.generationSources : {};
  const invalidSources = Object.entries(rawSources)
    .filter(([, source]) => !GENERATION_SOURCES.includes(source))
    .map(([field]) => field);
  if (invalidSources.length) reasons.push(`字段来源不在允许枚举内：${invalidSources.join('、')}`);
  if (!normalized.goal) addMissing('goal', '任务目标不能为空。');
  if (!normalized.inScope.length) addMissing('inScope', '当前目标和 PRD 没有提供可执行的范围内事项。');
  if (!normalized.outOfScope.length) addMissing('outOfScope', '合同必须明确范围外事项和默认安全边界。');
  if (!normalized.dod.length) addMissing('dod', '当前目标和 PRD 没有提供可验证的完成条件。');
  else if (!isVerifiableDod(normalized.dod)) addMissing('dod', '完成标准必须包含测试、检查、验证或其他可验证条件。');
  if (!normalized.evidence.length) addMissing('evidence', '当前目标和 PRD 没有提供可执行或可检查的验证证据。');
  else if (!isVerifiableEvidence(normalized.evidence)) addMissing('evidence', '验证证据必须包含命令、测试、构建、状态或文件结果等可检查方式。');
  if (normalized.needsHumanReason || normalized.humanGate.state === 'NEED_HUMAN') reasons.push(normalized.needsHumanReason || normalized.humanGate.reason || '当前合同需要人工处理。');
  const userFull = normalized.inScope.length > 0 && normalized.dod.length > 0 && normalized.evidence.length > 0;
  const researchRequired = normalized.research.status !== 'completed'
    && (normalized.generationStatus === 'research_required' || normalized.generationStatus === 'researching'
      || normalized.researchableFields.length > 0 || (normalized.confidence < 0.7 && !userFull));
  if (researchRequired) reasons.push('任务分析置信度或可执行字段不足，正在等待只读研究补全。');
  const permissionViolations = [];
  if (permissionSnapshot && typeof permissionSnapshot === 'object') {
    for (const permission of normalized.requiredPermissions) {
      const denied = permission.includes('网络') && permissionSnapshot.allowNetwork !== true
        || permission.includes('安装') && permissionSnapshot.allowInstall !== true
        || permission.includes('Git Push') && permissionSnapshot.allowGitPush !== true
        || permission.includes('敏感') && permissionSnapshot.allowSecrets !== true
        || permission.includes('外部') && permissionSnapshot.allowExternalSideEffects !== true
        || permission.includes('项目目录之外');
      if (denied) permissionViolations.push(permission);
    }
    if (normalized.research.status === 'permission_required'
      && (permissionSnapshot.researchRead !== true || !Array.isArray(permissionSnapshot.allowedResearchDomains) || !permissionSnapshot.allowedResearchDomains.length)) {
      permissionViolations.push('读取外部研究资料');
    }
  }
  if (permissionViolations.length) reasons.push(`所需权限未包含在当前预授权范围：${permissionViolations.join('、')}`);
  const researchConflict = ['conflict', 'timeout', 'budget_exceeded'].includes(normalized.research.status);
  const needsHuman = Boolean(normalized.needsHumanReason || normalized.humanGate.state === 'NEED_HUMAN'
    || normalized.humanRequiredFields.length || normalized.research.status === 'permission_required' || researchConflict);
  const valid = missingFields.length === 0 && !needsHuman && !researchRequired && permissionViolations.length === 0 && invalidSources.length === 0;
  const finalReasons = [...new Set(reasons)];
  return {
    valid, code: valid ? '' : 'TASK_CONTRACT_INCOMPLETE', contract: normalized,
    missingFields, missingFieldLabels: fieldLabels(missingFields), reasons: finalReasons,
    suggestedActions: valid ? [] : ['重新分析任务目标', '选择当前项目 PRD 或补充可验证验收条件', ...(researchRequired ? ['等待或允许只读研究补全项目资料'] : []), ...(permissionViolations.length ? ['检查 AutoPilot 安全策略，或移除未预授权的权限'] : []), ...(needsHuman ? ['进入 NEED_HUMAN，等待人工确认'] : [])],
    needsHuman,
    researchRequired,
    permissionViolations,
  };
}

function intakeError(code, message, statusCode = 400, details = {}) {
  const error = new Error(message);
  error.code = code; error.statusCode = statusCode; Object.assign(error, details); return error;
}

function mergeResearchIntoTaskContract(contract, researchValue) {
  const research = normalizeResearchState(researchValue);
  const findings = research.findings || {};
  const sourceType = research.sources.some((source) => source.kind === 'external') ? 'external_reference'
    : research.sources.length ? 'local_project_docs' : 'research';
  const generationSources = { ...contract.generationSources };
  const inferredFields = [...contract.inferredFields];
  const researchableFields = [...contract.researchableFields];
  const merged = { ...contract };
  for (const field of ['goal', 'inScope', 'outOfScope', 'dod', 'evidence', 'risks', 'assumptions', 'requiredPermissions']) {
    if (!Array.isArray(findings[field]) || !findings[field].length) continue;
    merged[field] = findings[field];
    generationSources[field] = sourceType;
    const inferredIndex = inferredFields.indexOf(field);
    if (inferredIndex >= 0) inferredFields.splice(inferredIndex, 1);
    const researchIndex = researchableFields.indexOf(field);
    if (researchIndex >= 0) researchableFields.splice(researchIndex, 1);
  }
  const unresolvedQuestions = research.unresolvedQuestions;
  const generationStatus = research.status === 'completed' && research.confidence >= 0.7 && !unresolvedQuestions.length
    ? 'ready' : ['conflict', 'timeout', 'budget_exceeded'].includes(research.status) ? 'needs_human' : 'research_required';
  const humanRequiredFields = ['conflict', 'timeout', 'budget_exceeded'].includes(research.status)
    ? [...new Set([...contract.humanRequiredFields, 'research'])] : contract.humanRequiredFields;
  return normalizeTaskContract({
    ...merged,
    classification: {
      ...contract.classification,
      confidence: Math.max(contract.classification.confidence, research.confidence),
    },
    confidence: Math.max(contract.confidence, research.confidence),
    generationStatus, generationSources, inferredFields, researchableFields, humanRequiredFields,
    assumptions: [...new Set([...(contract.assumptions || []), ...(research.assumptions || [])])],
    unresolvedQuestions,
    research,
    needsHumanReason: research.needsHumanReason || contract.needsHumanReason,
  });
}

async function previewTaskIntake({ projectPath, goal = '', prdMode = 'auto', prdPath = '', allowedRoots = [], env = process.env, fetchImpl = globalThis.fetch, runtimeContext, researcher = null, permissionSnapshot = null, researchLimits = {} } = {}) {
  const aliases = { current_project: 'current', custom: 'manual' };
  const mode = ['auto', 'current', 'manual', 'none'].includes(aliases[prdMode] || prdMode) ? (aliases[prdMode] || prdMode) : 'auto';
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
      if (selectable.length > 1) throw intakeError('PRD_SELECTION_REQUIRED', '发现多个 PRD 候选，请选择一个版本', 409, { candidates });
      if (selectable.length === 1) document = readPrdDocument({ projectPath, filePath: selectable[0].path, allowedRoots, selectedBy: 'auto' });
      else if (mode === 'current') throw intakeError('PRD_NOT_FOUND', '当前项目和允许的父级目录未找到 PRD', 404, { candidates: [] });
      else if (initialClassification.requiresPrd) warning = '未找到 PRD，已仅根据用户目标生成安全契约。';
    }
  }
  let normalization = null;
  if (document) {
    normalization = await generatePrdNormalization({ document, env, fetchImpl });
    if (normalization.warning) warning = normalization.warning;
  }
  const compiler = await generateTaskContractDraft({ goal, prdContent: document ? document.content : '', env, fetchImpl });
  if (compiler.warning) warning = [warning, compiler.warning].filter(Boolean).join(' ');
  const contract = buildTaskContract({
    goal, prd: normalization && normalization.parsed, source: document ? document.source : {},
    selectedBy: document ? document.source.selectedBy : 'none',
    aiDraft: compiler.draft || (normalization && normalization.aiDraft),
    runtimeContext, autoGenerate: true,
  });
  if (!contract.goal) throw intakeError('TASK_GOAL_REQUIRED', '任务目标缺失，请输入目标或选择包含明确目标的 PRD', 422);
  let validation = validateTaskContract({ contract, permissionSnapshot });
  let research = contract.research;
  const researchEligible = validation.researchRequired && !validation.needsHuman;
  if (researchEligible) {
    const activeResearcher = researcher && typeof researcher.research === 'function'
      ? researcher : createResearcher({ limits: researchLimits });
    try {
      research = await activeResearcher.research({
        projectPath, allowedRoots, goal: contract.goal, fields: contract.researchableFields,
        permissionSnapshot: permissionSnapshot || { researchRead: false, allowedResearchDomains: [] },
        attempts: contract.research.attempts,
      });
    } catch {
      research = { status: 'failed', errorCode: 'RESEARCH_PROVIDER_UNAVAILABLE', attempts: contract.research.attempts + 1 };
    }
    const researchedContract = mergeResearchIntoTaskContract(contract, research);
    validation = validateTaskContract({ contract: researchedContract, permissionSnapshot });
    return {
      taskContract: researchedContract, candidates, normalizationSource: normalization ? normalization.source : 'none', warning: !document && !warning ? '本合同仅根据任务目标生成，未读取 PRD。' : warning,
      analysis: {
        sourceSummary: researchedContract.sourceSummary, noPrd: !document,
        complexity: researchedContract.classification.complexity, riskLevel: researchedContract.classification.riskLevel,
        confidence: researchedContract.confidence,
        taskCompiler: { source: compiler.source, provider: compiler.provider || null, model: compiler.model || null },
        stages: ['project', 'prd', 'ai_compile', 'risk', 'contract', 'safety', 'research', 'validate'],
        stageStates: { project: 'completed', prd: document ? 'completed' : 'skipped', ai_compile: 'completed', risk: 'completed', contract: 'completed', safety: 'completed', research: researchedContract.research.status, validate: validation.valid ? 'completed' : 'blocked' },
        research: researchedContract.research,
        validation: { valid: validation.valid, needsHuman: validation.needsHuman, researchRequired: validation.researchRequired, missingFields: validation.missingFields, missingFieldLabels: validation.missingFieldLabels, reasons: validation.reasons, suggestedActions: validation.suggestedActions },
      },
    };
  }
  if (!document && !warning) warning = '本合同仅根据任务目标生成，未读取 PRD。';
  return {
    taskContract: contract, candidates, normalizationSource: normalization ? normalization.source : 'none', warning,
    analysis: {
      sourceSummary: contract.sourceSummary, noPrd: !document,
      complexity: contract.classification.complexity, riskLevel: contract.classification.riskLevel,
      confidence: contract.classification.confidence,
      taskCompiler: { source: compiler.source, provider: compiler.provider || null, model: compiler.model || null },
      stages: ['project', 'prd', 'ai_compile', 'risk', 'contract', 'safety', 'validate'],
      stageStates: { project: 'completed', prd: document ? 'completed' : 'skipped', ai_compile: 'completed', risk: 'completed', contract: 'completed', safety: 'completed', validate: validation.valid ? 'completed' : 'blocked' },
      research: contract.research,
      validation: { valid: validation.valid, needsHuman: validation.needsHuman, researchRequired: validation.researchRequired, missingFields: validation.missingFields, missingFieldLabels: validation.missingFieldLabels, reasons: validation.reasons, suggestedActions: validation.suggestedActions },
    },
  };
}

module.exports = {
  TASK_KINDS,
  COMPLEXITIES,
  RISK_LEVELS,
  GENERATION_SOURCES,
  GENERATION_STATUSES,
  DEFAULT_OUT_OF_SCOPE,
  buildTaskContract,
  classifyTask,
  normalizeTaskContract,
  autoCompleteTaskContract,
  previewTaskIntake,
  mergeResearchIntoTaskContract,
  validateTaskContract,
};
