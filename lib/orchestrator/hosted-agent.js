'use strict';

const crypto = require('node:crypto');

const HOSTED_REPLY_STATUSES = Object.freeze(['unknown', 'working', 'question', 'waiting_for_host', 'blocked', 'completed']);
const SENSITIVE = /((?:api[_ -]?key|authorization|bearer|oauth[_ -]?token|access[_ -]?token|refresh[_ -]?token|token|cookie|password|passwd|private[_ -]?key|prompt)\s*(?:=|:)\s*(?:bearer\s+)?)[^\s,;]+/gi;
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi;
const DECLARED_BLOCKED = /\bSTATUS\s*:\s*(?:BLOCKED|NEED_HUMAN)\b/i;
const SECRET = /(?:密钥|api[_\s-]*key|令牌|密码|cookie|私钥|private[_\s-]*key|完整\s*\.env|凭据|token)/i;
const DESTRUCTIVE = /(?:删除|清空|覆盖(?!点|率|范围|面|层|式|比|例)|git\s+push|部署|发布|安装(?:依赖)?|越权|扩大权限|绕过审批|自动授权|销毁|重置|格式化|外泄)/i;
const PERMISSION_ASK = /(?:请确认|是否允许|需要(?:你|您)?的?(?:授权|同意|确认|权限)|请求(?:授权|权限)|请授权|请允许|可否|能否授权)/i;
const COMMITTING_ACTION = /(?:我将|我要|我会|我准备|我计划|接下来|现在|开始|先|必须|正在|试图|请求|由我|帮你|来|去|进行|执行|对|把|会去|需要(?:你|您)?授权)/i;
const ORDINARY_QUESTION = /(?:请确认|是否需要|需要你|请提供|请告诉|请选择|哪一种|哪个方案|等待(?:用户|你的?)回复|你希望|要不要|是否要|\?？)/i;
const AGENT_FAILURE = /(?:执行失败|任务失败|无法继续|持续失败|失败原因|发生阻塞|被阻塞|blocked|failed|cannot continue|unable to continue)/i;
const NEGATED_SAFETY_ACTION = /(?:不|未|没有|尚未|暂无|禁止|不得|不会|不应|无需|不要|暂不)\s*(?:读取|输出|发送|获取|暴露|泄露|使用|处理|删除|清空|覆盖|购买|部署|发布|安装(?:依赖)?|联网|网络访问|修改|越权|扩大权限|绕过审批|自动授权)(?:\s*(?:网站|页面|文件|依赖|服务|内容|权限|数据|token|令牌|密码|密钥|\.env))?/gi;

const HOSTED_AGENT_CONTRACT = [
  '<ai_hosted_agent_contract>',
  '你当前收到的指令来自 AI 托管代理，不是人类逐轮手动输入。请把当前目标作为持续多轮任务推进。',
  '普通的页面、布局、文案、功能取舍、技术方案、测试方式和执行顺序由托管代理直接决定；信息不完整时采用最简单且可验证的方案，写明假设后继续执行。不要因普通问题回复“请确认”“等待用户”或把控制权交回人类。',
  '每轮回复使用以下结构：STATUS: WORKING / WAITING_FOR_HOST / BLOCKED / COMPLETED；DONE: 已完成事项；DECISION: 已采用决定或 NONE；NEXT: 下一步；BLOCKED: 阻塞原因或 NONE；EVIDENCE: 可验证文件、命令、测试结果或行为。阶段完成不等于最终完成。',
  '只有目标完成、没有待决策问题且提供可验证 Evidence 时才报告 STATUS: COMPLETED。不得编造用户个人资料。',
  '固定边界仍然有效：不删除或覆盖用户数据、不执行 Git Push、不自动安装依赖、不执行未授权网络访问、不读取或输出密钥 Token 密码完整 .env、不越过项目目录、不自动升级权限、不执行无法验证的危险操作。触及这些边界时报告 STATUS: BLOCKED 并保留现场。',
  '</ai_hosted_agent_contract>',
].join('\n');

function safeText(value, max = 500) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function redact(value, max = 500) {
  return safeText(value, max)
    .replace(SENSITIVE, '$1[REDACTED]')
    .replace(PRIVATE_KEY, '[REDACTED]');
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex').slice(0, 32);
}

function finiteTimestamp(value) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : null;
}

function messageText(message) {
  const value = message && (message.text || message.content || message.message);
  if (Array.isArray(value)) return value.map((item) => item && (item.text || item.content) || '').join(' ');
  return typeof value === 'string' ? value : '';
}

function appendHostedAgentContract(instruction) {
  const base = typeof instruction === 'string' ? instruction.trim() : '';
  return base ? `${base}\n\n${HOSTED_AGENT_CONTRACT}` : HOSTED_AGENT_CONTRACT;
}

function hasSafetyBoundary(text) {
  const clean = String(text || '').replace(NEGATED_SAFETY_ACTION, '');
  // A safety boundary is a real, immediate danger, not a mere mention of a
  // boundary word in a normal progress/explanation. Block only when the reply
  // (a) declares itself blocked/needs-human, (b) references a secret, or
  // (c) is explicitly committing to (or asking permission for) a destructive
  // operation. "正在联网查询天气" or "通过外部服务查询完成" must NOT block.
  if (DECLARED_BLOCKED.test(clean)) return true;
  if (SECRET.test(clean)) return true;
  return DESTRUCTIVE.test(clean) && (PERMISSION_ASK.test(clean) || COMMITTING_ACTION.test(clean));
}

// 「真实边界词」判定：仅由文本中的边界词（机密/破坏性操作）决定，不含
// "Agent 自报 STATUS: BLOCKED"。用于区分「真安全边界」（应暂停）与
// 「Agent 因换行符等琐碎差异自报 BLOCKED」（可交由 Supervisor 复核继续）。
function hasRealSafetyBoundary(text) {
  const clean = String(text || '').replace(NEGATED_SAFETY_ACTION, '');
  if (SECRET.test(clean)) return true;
  return DESTRUCTIVE.test(clean) && (PERMISSION_ASK.test(clean) || COMMITTING_ACTION.test(clean));
}

// 判断回复是否带有「明确完成」信号（DONE 段列出交付物，或完成性描述串）。
// 用于识别「Agent 自报 BLOCKED 但实际已完成（仅因换行符等琐碎差异误报）」的情况，
// 从而把该回复归为 completed，让循环自动收尾到 DONE，而不是重复指令/卡住。
function hasCompletionSignal(text) {
  const value = String(text || '');
  // safeText 会压缩换行，故用词边界匹配 Agent 的结构化 DONE 段：
  return /\bDONE\b\s*[:：]/i.test(value)
    || /(?:已完成|任务完成|全部完成|全部交付|均已完成|已成功(?:创建|完成|交付)|全部就绪)/i.test(value);
}

function classifyHostedAgentReply({ messages = [] } = {}) {
  const candidates = (Array.isArray(messages) ? messages : [])
    .filter((message) => ['assistant', 'agent', 'model'].includes(String(message && message.role || '').toLowerCase()))
    .map((message) => ({ message, text: redact(messageText(message), 2_000) }))
    .filter((item) => item.text);
  const latest = candidates[candidates.length - 1];
  if (!latest) return {
    status: 'unknown', requiresHostDecision: false, safetyBoundary: false, realSafetyBoundary: false,
    messageId: '', messageAt: null, summary: '',
  };

  const text = latest.text;
  const statusLine = text.match(/(?:^|\n)\s*STATUS\s*:\s*([A-Z_]+)/i);
  const declared = statusLine ? statusLine[1].toUpperCase() : '';
  const safetyBoundary = hasSafetyBoundary(text);
  const messageId = fingerprint(latest.message.source_id || latest.message.messageId || latest.message.id || `${latest.message.ts || latest.message.timestamp || ''}|${text}`);
  const base = {
    requiresHostDecision: false, safetyBoundary, realSafetyBoundary: hasRealSafetyBoundary(text), messageId,
    messageAt: finiteTimestamp(latest.message.ts ?? latest.message.timestamp), summary: redact(text, 500),
  };
  if (base.realSafetyBoundary || declared === 'NEED_HUMAN') {
    return { ...base, status: 'blocked', reasonCode: 'SAFETY_BOUNDARY' };
  }
  if (declared === 'WAITING_FOR_HOST') {
    return { ...base, status: 'waiting_for_host', requiresHostDecision: true, reasonCode: 'HOST_DECISION_REQUIRED' };
  }
  // Agent 自报 STATUS: BLOCKED 但无真实边界词：
  //  - 若回复含明确完成证据（DONE 段/完成描述）→ 实为「完成却被琐碎差异误报」，归为 completed，
  //    让循环 P0-B 自动收尾到 DONE（避免重复指令卡死）。
  //  - 否则视为 working 进展，交由 Supervisor 判断是否继续。
  if (declared === 'BLOCKED') {
    if (hasCompletionSignal(text)) {
      return { ...base, status: 'completed', reasonCode: 'AGENT_COMPLETED_AFTER_BLOCKED' };
    }
    return { ...base, status: 'working', reasonCode: 'AGENT_BLOCKED_NO_BOUNDARY' };
  }
  if (ORDINARY_QUESTION.test(text)) {
    return { ...base, status: 'question', requiresHostDecision: true, reasonCode: 'AGENT_QUESTION' };
  }
  if (AGENT_FAILURE.test(text)) {
    return { ...base, status: 'blocked', reasonCode: 'AGENT_FAILURE' };
  }
  if (declared === 'COMPLETED' || /(?:已完成|任务完成|全部完成|完成了目标|all\s+done|completed successfully)/i.test(text)) {
    return { ...base, status: 'completed', reasonCode: 'AGENT_COMPLETED' };
  }
  if (declared === 'WORKING') return { ...base, status: 'working', reasonCode: 'AGENT_WORKING' };
  return { ...base, status: 'working', reasonCode: 'AGENT_PROGRESS' };
}

function safeIdentifier(value, max = 200) {
  return safeText(value, max).replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, max);
}

function safeBlockedReason(value) {
  const normalized = safeText(value, 80).toUpperCase();
  return /^[A-Z][A-Z0-9_:-]{0,79}$/.test(normalized) ? normalized : '';
}

function normalizeHostedControl(value = {}) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const status = HOSTED_REPLY_STATUSES.includes(input.lastAgentMessageStatus) ? input.lastAgentMessageStatus : '';
  const round = Number.isInteger(input.round) && input.round >= 0 && input.round <= 1000 ? input.round : 0;
  const timestamp = (field) => finiteTimestamp(input[field]);
  return {
    enabled: input.enabled === true,
    sourceTaskId: safeIdentifier(input.sourceTaskId),
    targetTaskId: safeIdentifier(input.targetTaskId),
    hostId: safeIdentifier(input.hostId),
    round,
    lastSentMessageId: safeIdentifier(input.lastSentMessageId),
    lastAgentMessageId: safeIdentifier(input.lastAgentMessageId),
    lastHandledAgentMessageId: safeIdentifier(input.lastHandledAgentMessageId),
    lastAgentMessageStatus: status,
    lastAgentMessageAt: timestamp('lastAgentMessageAt'),
    lastDecisionAt: timestamp('lastDecisionAt'),
    blockedReason: safeBlockedReason(input.blockedReason),
  };
}

module.exports = {
  HOSTED_AGENT_CONTRACT,
  HOSTED_REPLY_STATUSES,
  appendHostedAgentContract,
  classifyHostedAgentReply,
  normalizeHostedControl,
  fingerprint,
};
