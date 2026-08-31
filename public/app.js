'use strict';
/* Agent Board 前端 v4：session 卡片 + 直连跳转 + 顶栏快捷图标 + 活跃时长统计 */

const sessionCardStacking = window.AgentBoardSessionStacking;
const themeManager = window.AgentBoardThemeManager;
const autopilotUi = window.AgentBoardAutoPilotUi;
let subagentStorage = null;
try {
  subagentStorage = window.localStorage;
} catch {}

const state = {
  agents: [], projects: [], active: [], agentsDef: {},
  project: '', q: '', range: 7, activeRange: 'day', activeProject: '',
  onlyUser: true,
  board: {}, agentIds: [], defaultAgentIds: [], colOrder: null,
  subagentCardStyle: sessionCardStacking.loadSubagentCardStyle(subagentStorage),
  expandedSubagentGroups: new Set(),
  // 实时活跃会话集合：由 SSE active 事件维护，渲染状态唯一权威来源
  liveRefs: new Set(),
  // Codex 线程/回合归并状态：与 liveRefs 分离，避免把所有状态压成二元值
  runtimeStatuses: new Map(),
  // session ref -> main/child，用于完成提示音和卡片状态保持同一套拓扑判断
  sessionRoles: new Map(),
  // 「刚完成」标记：ref -> completedAt ts（绿色流光），由 SSE 捕捉 进行中→已完成 迁移写入
  recentDone: new Map(),
  completionSounds: { assignments: {}, sounds: [], disabledAgents: [], disabledAgentRoles: [] },
  // 用户手动点「已读」取消高亮的 ref 集合（localStorage 持久化，避免刷新后重新点亮）
  dismissedRecent: new Set(),
  loading: false,
  stats: { total: 0, today: 0, active: 0 },
  popoverFor: null,
  monitorMode: 'manual',
  orchestration: { workflows: [], capabilities: {}, agentCapabilities: [], allowedRoots: [], headlessEnabled: false, jarvisVoice: null, routingCatalog: null, routingCapabilities: {}, providerConfig: null, secureProvider: null },
};

// Agent 显示配置：localStorage 持久化（显示哪些 agent），null 表示用默认
function loadColOrder() {
  try { return JSON.parse(localStorage.getItem('ab-cols')); } catch { return null; }
}
function saveColOrder(order) {
  localStorage.setItem('ab-cols', JSON.stringify(order));
}
// 有效列 = 配置顺序 ∩ 实际存在的 agent（防止配置了不存在的列）
function effectiveCols() {
  // colOrder 为 null（默认模式）时的候选列表用 defaultAgentIds（已安装/有历史数据过滤后的子集），
  // 不用全集 state.agentIds——这两行只在「默认视图」语境下才会被用到，要和 loadBoard()/
  // 「恢复默认」按钮保持同一套过滤规则，否则会出现短暂的过滤失效（见代码审查记录）。
  const def = state.colOrder || ['all', ...state.defaultAgentIds];
  // valid 集合必须用全集 state.agentIds：这里是「配置的列是否真实存在」的完整性校验，
  // 不是默认视图过滤，用户手动保存过的列（哪怕是被默认视图隐藏的 agent）也不该被判定无效。
  const valid = new Set(['all', ...state.agentIds]);
  const out = def.filter((c) => valid.has(c));
  // 只在默认模式（colOrder 为 null，用户从未手动配置）下自动补全新出现的 agent；
  // 一旦用户通过列设置保存过 colOrder，就完全尊重用户的选择（隐藏的列不补回）。
  if (!state.colOrder) {
    for (const id of state.defaultAgentIds) if (!out.includes(id)) out.push(id);
  }
  return out;
}

const $ = (id) => document.getElementById(id);
const requestJson = window.AgentBoardApi.requestJson;

// 兼容少数允许空 204/200 响应的旧接口；新接口统一走 requestJson。
async function readJsonResponse(response) {
  const raw = await response.text();
  if (!raw.trim()) throw new Error(`HTTP ${response.status}：服务端没有返回 JSON`);
  try { return JSON.parse(raw); } catch { throw new Error(`HTTP ${response.status}：服务端返回的不是有效 JSON`); }
}
async function readApiResponse(response) {
  const body = await response.text();
  if (!body.trim()) {
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return null;
  }
  const data = await readJsonResponse(new Response(body, { status: response.status, statusText: response.statusText }));
  if (!response.ok || data.error) throw new Error(data.error || ('HTTP ' + response.status));
  return data;
}
// HTML 转义：卡片/标题/消息文本含引号、尖括号时防止破坏 DOM 结构（Marvis 定时任务标题等）
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

// 精简标题：取文本清理后的前 N 字（抽屉锚点用）
function smartTitle(text, max = 40) {
  const t = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, max) : '';
}
function displaySessionId(sessionId) {
  const value = String(sessionId || '');
  return value.length > 16 ? `${value.slice(0, 8)}…${value.slice(-5)}` : value;
}
const clip = (txt) => navigator.clipboard.writeText(txt).then(() => true, () => false);

function fmtClock(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function fmtTimeLabel(ts) {
  // 会话卡 s-time 显示：今天/昨天 → "今天 09:11" / "昨天 09:11"；更早 → "MM-DD HH:MM" / "YYYY-MM-DD HH:MM"
  const d = new Date(ts);
  const n = new Date();
  const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const t = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (sameDay(d, n)) return `今天 ${t}`;
  const y = new Date(n); y.setDate(n.getDate() - 1);
  if (sameDay(d, y)) return `昨天 ${t}`;
  const sameYear = d.getFullYear() === n.getFullYear();
  const dateStr = sameYear
    ? `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `${dateStr} ${t}`;
}
function dayLabel(ts, now) {
  const d = new Date(ts);
  const n = new Date(now);
  const same = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (same(d, n)) return '今天';
  const y = new Date(n); y.setDate(n.getDate() - 1);
  if (same(d, y)) return '昨天';
  const sameYear = d.getFullYear() === n.getFullYear();
  return sameYear ? `${d.getMonth() + 1}月${d.getDate()}日` : `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}
function ago(ts) {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}秒前`;
  if (s < 3600) return `${Math.floor(s / 60)}分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)}小时前`;
  return `${Math.floor(s / 86400)}天前`;
}
function fmtDayFull(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${fmtClock(ts)}`;
}

/* ---------- 数据加载 ---------- */
function setRuntimeHealth(text, state = '') {
  const el = $('runtime-health');
  if (!el) return;
  el.textContent = text;
  el.className = `runtime-health ${state}`.trim();
}

async function loadHealth() {
  try {
    const data = await requestJson('/api/health');
    const collectors = Object.values(data.collectors || {});
    const errors = collectors.filter((item) => item.lastError);
    const available = collectors.filter((item) => item.rootExists).length;
    if (errors.length) {
      setRuntimeHealth(`后端已连接 · ${errors.length} 个采集器异常`, 'warning');
      return;
    }
    setRuntimeHealth(`后端正常 · ${available} 个数据源${data.scanning ? ' · 后台扫描中' : ''}`, 'ok');
  } catch (error) {
    setRuntimeHealth(`后端连接失败 · ${error.message || '请检查服务'}`, 'error');
  }
}

async function loadState() {
  try {
    const d = await requestJson('/api/state?range=' + state.activeRange);
    state.agents = d.agents; state.projects = d.projects; state.active = d.active;
    state.agentsDef = d.agentsDef || {};
    state.stats = d.stats;
    renderChips(); renderProjects(); renderStats(); renderQuickAgents(); renderActive();
  } catch (error) {
    setRuntimeHealth(`看板读取失败 · ${error.message || '请检查服务'}`, 'error');
  }
}

async function loadBoard() {
  if (state.loading) return;
  state.loading = true;
  try {
    const params = new URLSearchParams({ limit: 80 });
    if (state.project) params.set('project', state.project);
    if (state.q) params.set('q', state.q);
    if (state.range) params.set('range', String(state.range));
    if (state.onlyUser) params.set('onlyUser', '1');
    const d = await requestJson('/api/board?' + params);
    state.board = d.groups || state.board;
    for (const sessions of Object.values(state.board || {})) {
      for (const session of sessions || []) {
        const role = session?.session_role === 'child' || session?.session_role === 'main' ? session.session_role : null;
        if (session?.id && role) state.sessionRoles.set(session.id, role);
      }
    }
    state.agentIds = d.agentIds || [];
    // defaultAgentIds：探测为已安装 或 有历史数据的 agent 子集，只用来算「默认列」，
    // 不影响 state.agentIds（列设置弹窗仍然要能看到全部 agent，供手动勾选恢复）
    state.defaultAgentIds = d.defaultAgentIds || d.agentIds || [];
    // 后端返回的是一次完整的实时活跃快照。必须整体替换，
    // 否则 SSE 丢失/断线时，旧 live ref 会被永久并回去，已完成卡片就会一直显示进行中。
    if (Array.isArray(d.liveRefs)) {
      state.liveRefs = new Set(d.liveRefs);
    }
    if (d.runtimeStatuses && typeof d.runtimeStatuses === 'object') {
      state.runtimeStatuses = new Map(Object.entries(d.runtimeStatuses));
    }
    // 首次加载：把当前配置的列存好（默认 = all + 探测/历史数据过滤后的 agent）
    if (!state.colOrder) state.colOrder = loadColOrder() || ['all', ...state.defaultAgentIds];
    renderBoard();
  } catch (error) {
    setRuntimeHealth(`会话读取失败 · ${error.message || '请检查服务'}`, 'error');
  }
  finally { state.loading = false; }
}

const ORCHESTRATION_SLOT_LABELS = {
  supervisor_llm: 'Jarvis 监督模型', stt_streaming: '流式语音转文字', stt_batch: '非流式语音转文字',
  tts_streaming: '流式文生语音', tts_batch: '非流式文生语音', voice_clone: '语音克隆', vision: '视觉理解',
  image_generation: '文生图', video_generation: '视频生成', embeddings: '向量检索', moderation: '安全审核',
};
const ORCHESTRATION_STATUS_LABELS = {
  draft: '草稿', queued: '排队中', running: '执行中', waiting_user: '等待人工', verifying: '验收中',
  completed: '已完成', failed: '失败', paused: '已暂停',
};
const ORCHESTRATION_PROGRESS_LABELS = {
  not_started: '未开始', in_progress: '进行中', completed: '已完成', blocked: '已阻塞',
};
const ORCHESTRATION_AUTO_STATE_LABELS = {
  OFF: '未启动', PREFLIGHT: '准备中', WAITING_AGENT: '等待 Agent', REVIEWING: '监督复核',
  DISPATCHING: '发送中', VERIFYING: '验收送达', PAUSED: '已暂停', BLOCKED: '已阻塞',
  DONE: '已完成', STOPPED: '已停止',
};
const ORCHESTRATION_KIND_LABELS = { new: '新项目', existing: 'Git 项目维护', existing_unversioned: '未纳入 Git 的项目' };

async function loadOrchestration() {
  try {
    const data = await requestJson('/api/orchestration/state');
    const [routingCatalog, capabilityData] = await Promise.all([
      requestJson('/api/orchestration/routing/catalog').catch(() => null),
      requestJson('/api/capabilities').catch(() => null),
    ]);
    const secureProvider = typeof window.AgentBoardDesktop?.provider?.getStatus === 'function'
      ? await window.AgentBoardDesktop.provider.getStatus().catch(() => null) : null;
    state.orchestration = {
      workflows: Array.isArray(data.workflows) ? data.workflows : [],
      capabilities: data.capabilities || {}, allowedRoots: data.allowedRoots || [],
      agentCapabilities: Array.isArray(capabilityData?.items) ? capabilityData.items : [],
      headlessEnabled: data.headlessEnabled === true,
      jarvisVoice: data.jarvisVoice || null,
      providerConfig: data.providerConfig || null,
      secureProvider,
      settings: data.settings || null,
      routingCapabilities: routingCatalog?.capabilities || data.routingCapabilities || {},
      routingCatalog: routingCatalog && routingCatalog.catalog ? {
        ...routingCatalog.catalog,
        supportedAgents: routingCatalog.supportedAgents || [],
        capabilities: routingCatalog.capabilities || {},
      } : null,
    };
    renderAIMonitor();
    if (state.board && Object.keys(state.board).length) renderBoard();
  } catch (error) {
    $('ai-readiness').textContent = `AI 监控服务未连接：${error.message || '请求失败'}`;
  }
}

function renderAIMonitor() {
  const data = state.orchestration;
  const capabilities = data.capabilities || {};
  const supervisor = capabilities.supervisor_llm || {};
  const voice = data.jarvisVoice || {};
  const roots = data.allowedRoots.length ? `允许目录 ${data.allowedRoots.length} 个` : '尚未配置允许项目目录';
  const voiceReady = voice.enabled && voice.asr && voice.asr.available && voice.tts && voice.tts.available && voice.workbuddy && voice.workbuddy.available;
  $('ai-readiness').textContent = `${supervisor.available ? '监督模型已就绪' : '监督模型未配置'} · ${data.headlessEnabled ? 'headless 已开启' : 'headless 未开启'} · ${voiceReady ? '语音 MVP 已就绪' : '语音 MVP 未就绪'} · ${roots}`;
  const jarvisProject = $('jarvis-project-path');
  if (jarvisProject && !jarvisProject.value) jarvisProject.value = localStorage.getItem('ab-jarvis-project') || $('ai-project-path').value || '';
  setJarvisStatus(voiceReady ? '可以开始录音' : '请先在设置中配置智谱 Key、headless、允许目录和 WorkBuddy CLI');

  const capabilityBox = $('ai-capability-list');
  capabilityBox.innerHTML = Object.entries(ORCHESTRATION_SLOT_LABELS).map(([slot, label]) => {
    const item = capabilities[slot] || {};
    return `<div class="ai-capability"><b>${esc(label)}</b><span class="${item.available ? 'ready' : 'missing'}">${item.available ? `可用 · ${esc(item.providerName || item.provider || '')}` : '未配置'}</span></div>`;
  }).join('');
  const agentCapabilityBox = $('ai-agent-capability-list');
  if (agentCapabilityBox) {
    const capabilityLabels = [
      ['sessionAuto', 'Session Auto', ['sessionLocator', 'sessionActivator', 'identityVerifier', 'messageWriter', 'deliveryVerifier', 'completionDetector']],
      ['conversationReader', 'Conversation Read', ['conversationReader']],
      ['completion', 'Completion', ['completionDetector']],
      ['verifiedSend', 'Verified Send', ['identityVerifier', 'messageWriter', 'deliveryVerifier']],
    ];
    const routeLabels = [
      ['modelDiscovery', 'Model Discovery'], ['modelSwitch', 'Model Switch'], ['reasoningControl', 'Reasoning'],
    ];
    const items = Array.isArray(data.agentCapabilities) ? data.agentCapabilities : [];
    const mark = (value) => `<span class="${value ? 'ready' : 'missing'}">${value ? '✓' : '✕'}</span>`;
    agentCapabilityBox.innerHTML = items.length ? items.map((entry) => {
      const agent = entry && entry.agentId ? String(entry.agentId) : '';
      const capabilities = entry && entry.capabilities && typeof entry.capabilities === 'object' ? entry.capabilities : {};
      const supported = (name) => capabilities[name]?.supported === true;
      const route = data.routingCapabilities?.[agent] || {};
      const highLevel = capabilityLabels.map(([, label, names]) => `${label} ${mark(names.every(supported))}`);
      const routing = routeLabels.map(([name, label]) => `${label} ${mark(route[name] === true)}`);
      return `<div class="ai-agent-capability-card"><strong>${esc(agent)}</strong><span>${highLevel.join('</span><span>')}</span><span>${routing.join('</span><span>')}</span></div>`;
    }).join('') : '<div class="ai-routing-status">暂无能力注册表；请检查后端连接。</div>';
  }
  const routingCapabilityBox = $('ai-routing-capability-list');
  if (routingCapabilityBox) {
    const routingCapabilities = data.routingCapabilities || {};
    const agents = Object.keys(routingCapabilities);
    routingCapabilityBox.innerHTML = agents.length ? agents.map((agent) => {
      const item = routingCapabilities[agent] || {};
      const mark = (value) => `<span class="${value ? 'ready' : 'missing'}">${value ? '✓' : '✕'}</span>`;
      return `<div class="ai-routing-capability-card"><strong>${esc(agent)}</strong><span>Model Discovery ${mark(item.modelDiscovery)}</span><span>Model Switch ${mark(item.modelSwitch)}</span><span>Reasoning ${mark(item.reasoningControl)}</span><span>Profile Verification ${mark(item.profileVerification)}</span></div>`;
    }).join('') : '<div class="ai-routing-status">暂无可用的 Model Routing Adapter；基础 AutoPilot 不受影响。</div>';
  }

  const providerBox = $('ai-provider-config');
  if (providerBox) {
    const provider = data.providerConfig || {};
    const secureProvider = data.secureProvider || {};
    const status = (item, readyLabel, missingLabel) => `<span class="${item?.available ? 'ready' : 'missing'}">${item?.available ? readyLabel : missingLabel}</span>`;
    const supervisor = provider.supervisor || {};
    const worker = provider.workerRouting || {};
    const providerLabels = { dashscope: '阿里云百炼', zai: '智谱', ark: '火山方舟', minimax: 'MiniMax', deepgram: 'Deepgram', elevenlabs: 'ElevenLabs', openai: 'OpenAI', anthropic: 'Anthropic', gemini: 'Gemini', deepseek: 'DeepSeek', openrouter: 'OpenRouter', 'openai-compatible': 'OpenAI-compatible' };
    const providerOptions = Object.entries(providerLabels).map(([id, label]) => `<option value="${id}">${label}</option>`).join('');
    const configured = Array.isArray(secureProvider.configuredProviders) ? secureProvider.configuredProviders : [];
    const configuredLabel = configured.length ? configured.map((item) => providerLabels[item] || item).join('、') : '暂无';
    const providerBridge = window.AgentBoardDesktop?.provider;
    const secureEditor = providerBridge
      ? `<form class="ai-provider-key-form" id="ai-provider-key-form"><label>Agent 共用 Provider Key（Electron safeStorage）<select id="ai-provider-key-provider">${providerOptions}</select><input id="ai-provider-key" type="password" autocomplete="new-password" placeholder="保存一次，所有 Agent 共用" required></label><div class="ai-provider-key-actions"><button type="submit" class="btn primary">安全保存</button><button type="button" class="btn" id="ai-provider-key-clear">清除选中 Key</button></div></form>`
      : '<div class="ai-provider-note">当前为浏览器模式；Provider Key 请通过服务端环境变量配置。</div>';
    providerBox.innerHTML = `<div class="ai-provider-row"><strong>Supervisor</strong><span>${esc(supervisor.providerName || supervisor.provider || '未选择供应商')} · ${esc(supervisor.model || '默认模型')}</span>${status(supervisor, '凭据已配置', '未配置凭据')}</div>
      <div class="ai-provider-row"><strong>Worker Routing</strong><span>${esc(worker.providerName || worker.provider || '由 Agent Adapter 决定')} · ${esc(worker.model || '自动选择')}</span>${status(worker, '已启用', '未启用')}</div>
      <div class="ai-provider-note">统一凭据：所有 Agent 共用；语音 ASR/TTS 当前使用智谱 Key。安全存储：${secureProvider.available ? 'Electron safeStorage 可用' : '不可用'} · 已配置：${esc(configuredLabel)}${secureProvider.activeProvider ? ` · 当前 Supervisor：${esc(providerLabels[secureProvider.activeProvider] || secureProvider.activeProvider)}` : ''}。Key 不会回显；基础 AutoPilot：${provider.baseAutoPilot?.blocking === false ? '不受 Provider 配置阻塞' : '请检查配置'}。</div>${secureEditor}`;
    if (providerBridge) {
      const providerSelect = providerBox.querySelector('#ai-provider-key-provider');
      if (secureProvider.activeProvider && providerLabels[secureProvider.activeProvider]) providerSelect.value = secureProvider.activeProvider;
      providerBox.querySelector('#ai-provider-key-form')?.addEventListener('submit', async (event) => {
        event.preventDefault();
        const input = providerBox.querySelector('#ai-provider-key');
        try {
          const result = await providerBridge.setApiKey(providerSelect.value, input.value);
          if (!result?.ok) throw new Error(result?.error || 'Provider Key 保存失败');
          input.value = '';
          toast('Provider Key 已通过 safeStorage 保存，后端已重启');
          await loadOrchestration();
        } catch (error) { toast(error.message || 'Provider Key 保存失败'); }
      });
      providerBox.querySelector('#ai-provider-key-clear')?.addEventListener('click', async () => {
        if (!window.confirm('确认清除当前 Provider 的本机安全凭据？')) return;
        try {
          const result = await providerBridge.clearApiKey(providerSelect.value);
          if (!result?.ok) throw new Error(result?.error || 'Provider Key 清除失败');
          toast('Provider Key 已清除，后端已重启');
          await loadOrchestration();
        } catch (error) { toast(error.message || 'Provider Key 清除失败'); }
      });
    }
  }

  const list = $('ai-workflow-list');
  const workflows = data.workflows || [];
  renderRoutingCreateFields(data.routingCatalog);
  if (!workflows.length) { list.innerHTML = '<div class="ai-empty">暂无 AI 工作流</div>'; return; }
  list.innerHTML = workflows.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).map((workflow) => {
    const plan = workflow.executionPlan || {};
    const classification = workflow.classification || {};
    const status = workflow.status || 'draft';
    const contract = workflow.runContract || {};
    const goal = contract.goal || plan.goal || workflow.id;
    const progress = workflow.progress || workflow.lastSuggestion?.progress || {};
    const suggestion = workflow.lastSuggestion || {};
    const autoState = workflow.autoState || 'OFF';
    const isAuto = workflow.autopilotMode === 'auto';
    const canSuggest = status !== 'completed' && autoState !== 'STOPPED';
    const canAutoRun = isAuto && !['DONE', 'STOPPED', 'PAUSED', 'BLOCKED'].includes(autoState) && workflow.controlOwner !== 'human';
    const canResume = isAuto && ['PAUSED', 'BLOCKED'].includes(autoState);
    const canStop = isAuto && !['DONE', 'STOPPED'].includes(autoState);
    const canTakeover = !['completed', 'paused'].includes(status) && workflow.controlOwner !== 'human';
    const routingConfig = workflow.routingConfig || {};
    const actions = [];
    if (canSuggest) actions.push(`<button class="btn primary ai-workflow-action" data-action="suggest" data-id="${esc(workflow.id)}">生成下一步建议</button>`);
    if (canAutoRun) actions.push(`<button class="btn primary ai-workflow-action" data-action="auto-run" data-id="${esc(workflow.id)}">启动 Auto</button>`);
    if (canResume) actions.push(`<button class="btn primary ai-workflow-action" data-action="resume" data-id="${esc(workflow.id)}">恢复 Auto</button>`);
    if (canStop) actions.push(`<button class="btn ai-workflow-action" data-action="stop" data-id="${esc(workflow.id)}">停止 Auto</button>`);
    if (canTakeover) actions.push(`<button class="btn ai-workflow-action" data-action="takeover" data-id="${esc(workflow.id)}">人工接管</button>`);
    if (workflow.agent === 'codex' || routingConfig.enabled) actions.push(`<button class="btn ai-workflow-action" data-action="routing-details" data-id="${esc(workflow.id)}">路由详情</button>`);
    const dodTotal = Number.isInteger(progress.total) ? progress.total : (Array.isArray(contract.verify?.dod) ? contract.verify.dod.length : 0);
    const dodPassed = Number.isInteger(progress.completed) ? progress.completed : 0;
    const progressLabel = ORCHESTRATION_PROGRESS_LABELS[progress.status] || '未开始';
    const suggestionText = suggestion.nextStep || suggestion.reason || '尚未生成建议';
    const route = workflow.lastRouting || null;
    const routeReason = { ROUTE_ESCALATED: '失败后升级', ROUTE_DOWNGRADED: '任务简化后降级', MANUAL_PIN: '人工锁定', ROUTING_UNAVAILABLE: '路由能力不可用', PROFILE_VERIFY_FAILED: 'Profile 验证失败' };
    const routeSummary = route && (route.modelId || route.reasonCode)
      ? `<div class="ai-route-summary">智能路由：${esc(route.modelId || '未应用')} · ${esc(route.reasoningLevel || '未验证')} · ${esc(route.source || '未应用')} · ${esc(routeReason[route.reasonCode] || route.reasonCode || '当前配置')} ${route.catalogStale ? '· Catalog stale' : ''}</div>`
      : routingConfig.enabled ? '<div class="ai-route-summary">智能路由已启用，等待下一轮 Catalog 与 Profile 验证。</div>' : '';
    return `<article class="ai-workflow-card ${esc(status)}">
      <div class="ai-workflow-top"><strong title="${esc(goal)}">${esc(smartTitle(goal, 80))}</strong><span class="ai-badge status">${esc(ORCHESTRATION_STATUS_LABELS[status] || status)}</span><span class="ai-badge">${esc(isAuto ? 'Auto' : 'Suggest')}</span><span class="ai-badge">${esc(ORCHESTRATION_KIND_LABELS[classification.kind] || classification.kind || '待识别')}</span></div>
      <div class="ai-workflow-meta" title="${esc(workflow.projectPath)}">${esc(workflow.projectPath)} · ${esc(workflow.mode === 'global' ? '全局策略' : '单项目')} · ${esc(workflow.agent || '未指定 Agent')} · 控制：${esc(workflow.controlOwner || '无')} · FSM：${esc(ORCHESTRATION_AUTO_STATE_LABELS[autoState] || autoState)}</div>
      ${isAuto && workflow.binding?.sessionRef ? `<div class="ai-workflow-meta" title="${esc(workflow.binding.sessionRef)}">Session：${esc(workflow.binding.sessionRef)}</div>` : ''}
      <div class="ai-workflow-meta">进度：${esc(progressLabel)} · DoD ${esc(dodPassed)}/${esc(dodTotal)} · ${esc(progress.percent || 0)}%</div>
      ${routeSummary}
      <div class="ai-workflow-meta">下一步建议：${esc(suggestionText)}</div>
      ${suggestion.receipt?.generatedAt ? `<div class="ai-workflow-meta">最近回执：${esc(suggestion.receipt.generatedAt)}</div>` : ''}
      ${workflow.lastError ? `<div class="ai-workflow-error">${esc(workflow.lastError)}</div>` : ''}
      <div class="ai-workflow-actions">${actions.join('') || '<span class="ai-hint">当前状态无需操作</span>'}</div>
    </article>`;
  }).join('');
}

function setMonitorMode(mode) {
  state.monitorMode = mode === 'ai' ? 'ai' : 'manual';
  document.querySelectorAll('[data-monitor-mode]').forEach((button) => button.classList.toggle('active', button.dataset.monitorMode === state.monitorMode));
  $('manual-monitor-panel').hidden = state.monitorMode !== 'manual';
  $('ai-monitor-panel').hidden = state.monitorMode !== 'ai';
  if (state.monitorMode === 'ai') return loadOrchestration();
  return Promise.resolve();
}

let jarvisRecorder = null;
let jarvisStream = null;
let jarvisChunks = [];

function setJarvisStatus(text) {
  const node = $('jarvis-voice-status');
  if (node) node.textContent = text;
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
    reader.onerror = () => reject(new Error('录音读取失败'));
    reader.readAsDataURL(blob);
  });
}

async function submitJarvisRecording(blob) {
  const projectPath = $('jarvis-project-path').value.trim();
  if (!projectPath) throw new Error('请先填写 Session 项目目录');
  localStorage.setItem('ab-jarvis-project', projectPath);
  const audioBase64 = await blobToBase64(blob);
  const response = await fetch('/api/jarvis/voice', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ audioBase64, mimeType: blob.type || 'audio/webm', projectPath }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Jarvis 语音任务失败');
  $('jarvis-transcript').textContent = data.transcript || '';
  $('jarvis-summary').textContent = data.summary || '';
  $('jarvis-detail-path').textContent = data.detailPath ? `详细 session：${data.detailPath}` : '';
  $('jarvis-voice-result').hidden = false;
  const audio = $('jarvis-audio');
  audio.removeAttribute('src');
  if (data.audio && data.audio.url) {
    audio.src = data.audio.url;
    audio.load();
    audio.play().catch(() => {});
    setJarvisStatus('已完成，摘要音频已返回');
  } else {
    setJarvisStatus('已完成，但 TTS 未生成；已保留文字摘要和详细 session');
    if (window.speechSynthesis && data.summary) window.speechSynthesis.speak(new SpeechSynthesisUtterance(data.summary));
  }
  await loadOrchestration();
}

async function startJarvisRecording() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof MediaRecorder === 'undefined') {
    throw new Error('当前环境不支持浏览器录音');
  }
  jarvisStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const preferredType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
  jarvisChunks = [];
  jarvisRecorder = new MediaRecorder(jarvisStream, { mimeType: preferredType });
  jarvisRecorder.ondataavailable = (event) => { if (event.data && event.data.size) jarvisChunks.push(event.data); };
  jarvisRecorder.onstop = async () => {
    const blob = new Blob(jarvisChunks, { type: jarvisRecorder.mimeType || preferredType });
    jarvisRecorder = null;
    if (jarvisStream) jarvisStream.getTracks().forEach((track) => track.stop());
    jarvisStream = null;
    $('jarvis-record').disabled = true;
    $('jarvis-record').textContent = '处理中…';
    setJarvisStatus('正在识别、判断、调用 WorkBuddy 并生成摘要音频…');
    try { await submitJarvisRecording(blob); } catch (error) { setJarvisStatus(error.message || 'Jarvis 语音任务失败'); }
    $('jarvis-record').disabled = false;
    $('jarvis-record').textContent = '开始录音';
    $('jarvis-record').classList.remove('ai-voice-recording');
  };
  jarvisRecorder.start();
  $('jarvis-record').textContent = '停止录音';
  $('jarvis-record').classList.add('ai-voice-recording');
  setJarvisStatus('录音中，再次按下结束');
}

function stopJarvisRecording() {
  if (jarvisRecorder && jarvisRecorder.state !== 'inactive') jarvisRecorder.stop();
}

async function runOrchestrationAction(action, id) {
  if (action === 'routing-details') return openRoutingCommercialOverview(id);
  const endpoints = { takeover: 'takeover', suggest: 'suggest', 'auto-run': 'run', resume: 'resume', stop: 'stop' };
  const endpoint = endpoints[action] || 'suggest';
  try {
    await requestJson(`/api/orchestration/workflows/${encodeURIComponent(id)}/${endpoint}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    });
    const message = action === 'takeover' ? '已人工接管，AI 工作流已暂停'
      : action === 'auto-run' ? 'Auto Loop 已启动，正在等待验证结果'
        : action === 'resume' ? '已恢复 Auto Loop，开始重新复核'
          : action === 'stop' ? 'Auto Loop 已停止' : '已生成下一步建议，未自动执行';
    toast(message);
    await loadOrchestration();
  } catch (error) { toast(error.message || 'AI 工作流操作失败'); }
}

document.querySelectorAll('[data-monitor-mode]').forEach((button) => button.addEventListener('click', () => setMonitorMode(button.dataset.monitorMode)));
$('jarvis-record').addEventListener('click', async () => {
  try {
    if (jarvisRecorder) stopJarvisRecording();
    else await startJarvisRecording();
  } catch (error) {
    if (jarvisStream) jarvisStream.getTracks().forEach((track) => track.stop());
    jarvisStream = null; jarvisRecorder = null;
    setJarvisStatus(error.message || '无法开始录音');
  }
});
$('jarvis-project-path').addEventListener('input', (event) => localStorage.setItem('ab-jarvis-project', event.target.value.trim()));
function contractLines(value) {
  return String(value || '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
}
$('ai-create-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const dod = contractLines($('ai-dod').value);
  if (!dod.length) { toast('请至少填写一条 DoD'); return; }
  const autopilotMode = $('ai-autopilot-mode').value;
  const sessionRef = $('ai-session-ref').value.trim();
  if (autopilotMode === 'auto' && !sessionRef) { toast('Auto 模式必须填写 Session Ref'); return; }
  const body = {
    projectPath: $('ai-project-path').value.trim(), goal: $('ai-goal').value.trim(),
    agent: $('ai-agent').value, mode: $('ai-mode').value, requestedBy: 'human', autopilotMode,
    scope: { inScope: contractLines($('ai-in-scope').value), outOfScope: contractLines($('ai-out-of-scope').value) },
    verify: { dod, evidence: contractLines($('ai-evidence').value) },
    routingConfig: routingConfigFromCreateForm(),
    ...(sessionRef ? { binding: { sessionRef, agent: $('ai-agent').value, projectPath: $('ai-project-path').value.trim() } } : {}),
  };
  try {
    const data = await requestJson('/api/orchestration/workflows', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    toast(`已创建${ORCHESTRATION_KIND_LABELS[data.classification.kind] || ''} AI 工作流`);
    $('ai-goal').value = '';
    await loadOrchestration();
  } catch (error) { toast(error.message || 'AI 工作流创建失败'); }
});
$('ai-workflow-list').addEventListener('click', (event) => {
  const button = event.target.closest('.ai-workflow-action');
  if (button) runOrchestrationAction(button.dataset.action, button.dataset.id);
});
$('ai-agent').addEventListener('change', () => {
  const enabled = routingAgentSupported($('ai-agent').value);
  $('ai-routing-enabled').disabled = !enabled;
  if (!enabled) $('ai-routing-enabled').checked = false;
  $('ai-routing-status').textContent = enabled
    ? '模型与 reasoning 将按当前 Agent 能力校验。'
    : '当前 Agent 不支持 Model Routing；基础 AutoPilot 仍可正常使用。';
});

/* ---------- 顶栏 AI Agent 快捷图标 ---------- */
function agentIconMarkup(def, className = '') {
  const iconClass = className ? ` class="${esc(className)}"` : '';
  if (def && def.icon) return `<img src="/icons/${esc(def.icon)}" alt=""${iconClass}>`;
  const letter = (def?.name || def?.id || '?').replace(/[^A-Za-z\u4e00-\u9fff]/g, '').slice(0, 1) || '?';
  return `<span class="qb" style="background:${esc(def?.color || '#888')}">${esc(letter)}</span>`;
}
function renderQuickAgents() {
  const box = $('quick-agents'); box.innerHTML = '';
  const defs = state.agentsDef || {};
  for (const id of Object.keys(defs)) {
    const def = defs[id];
    const btn = document.createElement('button');
    btn.className = 'qa-btn';
    btn.title = def.name + '（点击：未运行则启动，已运行则跳转）';
    btn.innerHTML = agentIconMarkup(def);
    btn.onclick = () => launchAgent(id);
    box.appendChild(btn);
  }
}

async function configureAgentPath(agent) {
  return requestJson(`/api/agents/${encodeURIComponent(agent)}/discover-path`, { method: 'POST' });
}

function launchFailureText(name, data) {
  const recovery = data?.recovery || {};
  if (recovery.detectedPath) {
    return `${name}：未确认成功打开，已找到真实路径，请在应用管理点击“自动配置路径”后重试`;
  }
  const hint = Array.isArray(recovery.suggestions) && recovery.suggestions[0]
    ? `；建议：${recovery.suggestions[0]}`
    : '';
  return `${name}：${data?.error || '未成功打开'}${hint}`;
}

async function launchAgent(agent, target = '', options = {}) {
  const def = state.agentsDef[agent];
  const name = def ? def.name : agent;
  const targetLabel = target === 'cli' ? ' CLI' : target === 'desktop' ? ' 桌面端' : '';
  toast(`正在处理 ${name}${targetLabel}…`);
  try {
    const d = await requestJson('/api/launch-agent', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(target ? { agent, target } : { agent }),
      allowFailure: true,
    });
    if (d.ok) {
      const pending = d.verified === null || d.verification === 'pending';
      toast(pending
        ? `${name}${targetLabel}：已投递启动请求，正在确认窗口`
        : (targetLabel ? `${name}${targetLabel}：已启动` : `${name}：已运行则跳转，未运行已启动`));
    } else if (!options.retried && target !== 'desktop' && d.recovery?.autoConfigureAvailable) {
      try {
        const configured = await configureAgentPath(agent);
        toast(`${name}：未确认打开，已找到并配置路径，正在重试…`);
        return launchAgent(agent, target, { retried: true, configuredPath: configured.path });
      } catch { /* 自动配置失败时继续显示完整恢复指引 */ }
      toast(launchFailureText(name, d));
      setTimeout(() => openAgentManager(true, agent), 0);
    } else {
      toast(launchFailureText(name, d));
      setTimeout(() => openAgentManager(true, agent), 0);
    }
  } catch (error) {
    toast(`${name}：${error.message || '请求失败'}`);
  }
  // 延迟刷新运行状态标记
  setTimeout(refreshRunStatus, 1200);
}
function extractCodexThreadId(sessionId) {
  const match = String(sessionId || '').match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  return match ? match[1] : null;
}
async function openCodexThread(sessionId) {
  const threadId = extractCodexThreadId(sessionId);
  if (!threadId) {
    toast('Codex：无效的会话 ID');
    return false;
  }
  toast('正在打开 Codex 会话…');
  try {
    const d = await requestJson('/api/open-codex-thread', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadId }),
    });
    toast(d.action === 'protocol-dispatched' ? 'Codex：已投递会话协议' : 'Codex：已打开指定会话');
    return d?.ok !== false;
  } catch (error) { toast(`Codex：${error.message || '请求失败'}`); return false; }
}
async function openWorkBuddySession(sessionId) {
  if (!sessionId) {
    toast('WorkBuddy：无效的会话 ID');
    return false;
  }
  toast('正在打开 WorkBuddy 会话…');
  try {
    const d = await requestJson('/api/open-workbuddy-session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });
    toast(d.windowVerified === false ? 'WorkBuddy：已发送启动请求，但未确认窗口' : 'WorkBuddy：已打开指定会话');
    return d?.ok !== false && d?.windowVerified !== false;
  } catch (error) { toast(`WorkBuddy：${error.message || '请求失败'}`); return false; }
}
async function openMarvisSession(sessionId) {
  if (!sessionId) {
    toast('Marvis：无效的会话 ID');
    return false;
  }
  toast('正在打开 Marvis 会话…');
  try {
    const d = await requestJson('/api/open-marvis-session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });
    toast('Marvis：已打开指定会话');
    return d?.ok !== false;
  } catch (error) { toast(`Marvis：${error.message || '请求失败'}`); return false; }
}
async function openClaudeSession(sessionId) {
  if (!sessionId) {
    toast('Claude Code：无效的会话 ID');
    return false;
  }
  toast('正在打开 Claude Desktop 会话…');
  try {
    const d = await requestJson('/api/open-claude-session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });
    toast(d.windowVerified === false ? 'Claude Code：已发送请求，但未确认窗口' : 'Claude Code：已打开指定 Desktop 会话');
    return d?.ok !== false && d?.windowVerified !== false;
  } catch (error) { toast(`Claude Code：${error.message || '请求失败'}`); return false; }
}
async function openZCodeSession(sessionId) {
  if (!sessionId) {
    toast('ZCode：无效的会话 ID');
    return false;
  }
  toast('正在打开 ZCode 会话…');
  try {
    const d = await requestJson('/api/open-zcode-session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });
    toast('ZCode：已打开指定会话');
    return d?.ok !== false;
  } catch (error) { toast(`ZCode：${error.message || '请求失败'}`); return false; }
}
async function openDeepSeekSession(sessionId) {
  if (!sessionId) {
    toast('DeepSeek Harness：无效的会话 ID');
    return false;
  }
  toast('正在打开 DeepSeek Harness 桌面端会话…');
  try {
    const d = await requestJson('/api/open-deepseek-session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });
    toast(d.windowVerified === false ? 'DeepSeek Harness：已发送请求，但未确认窗口' : 'DeepSeek Harness：已打开指定桌面端会话');
    return d?.ok !== false && d?.windowVerified !== false;
  } catch (error) { toast(`DeepSeek Harness：${error.message || '请求失败'}`); return false; }
}
async function openPiAgentSession(sessionId) {
  if (!sessionId) {
    toast('Pi Agent：无效的会话 ID');
    return false;
  }
  toast('正在打开 Pi Agent Desktop 会话…');
  try {
    const d = await requestJson('/api/open-pi-agent-session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });
    toast('Pi Agent：已打开指定桌面端会话');
    return d?.ok !== false;
  } catch (error) { toast(`Pi Agent：${error.message || '请求失败'}`); return false; }
}
async function openHermesSession(sessionId) {
  if (!sessionId) {
    toast('Hermes Agent：无效的会话 ID');
    return false;
  }
  toast('正在打开 Hermes Desktop 会话…');
  try {
    const d = await requestJson('/api/open-hermes-session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });
    toast('Hermes Agent：已打开指定 Desktop 会话');
    return d?.ok !== false;
  } catch (error) { toast(`Hermes Agent：${error.message || '请求失败'}`); return false; }
}
function sessionNavigationId(s) {
  const syntheticChild = s?.session_role === 'child'
    && (s.agent === 'marvis' || s.agent === 'hermes')
    && String(s.session_id || '').includes(':subagent:');
  if (!syntheticChild || !s.parent_session_ref) return s.session_id;
  const prefix = `${s.agent}:`;
  return String(s.parent_session_ref).startsWith(prefix)
    ? String(s.parent_session_ref).slice(prefix.length)
    : s.session_id;
}
function jumpToAgentSession(s) {
  // Native desktop links cannot resolve synthetic Marvis/Hermes child IDs. Keep the
  // card/session identity untouched and use a short-lived navigation view instead.
  const navigationId = sessionNavigationId(s);
  s = { ...s, session_id: navigationId };
  if (s.agent === 'claude') return openClaudeSession(s.session_id);
  if (s.agent === 'codex') return openCodexThread(s.session_id);
  if (s.agent === 'workbuddy') return openWorkBuddySession(s.session_id);
  if (s.agent === 'marvis') return openMarvisSession(s.session_id);
  if (s.agent === 'deepseek') return openDeepSeekSession(s.session_id);
  if (s.agent === 'zcode') return openZCodeSession(s.session_id);
  if (s.agent === 'pi') return openPiAgentSession(s.session_id);
  if (s.agent === 'hermes') return openHermesSession(s.session_id);
  return launchAgent(s.agent);
}
async function jumpToLatestCompleted() {
  const sessions = Array.isArray(state.board.all)
    ? state.board.all
    : Object.values(state.board).flatMap((list) => Array.isArray(list) ? list : []);
  const candidate = window.AgentBoardRecentCompletedJump.findLatestEligibleCompletion(sessions, {
    recentDone: state.recentDone,
    dismissedRecent: state.dismissedRecent,
    liveRefs: state.liveRefs,
    runtimeStatuses: state.runtimeStatuses,
    ttl: RECENT_DONE_TTL,
  });
  if (!candidate) {
    toast('暂无符合条件的已完成任务');
    return false;
  }

  const jumped = await jumpToAgentSession(candidate.session);
  if (jumped) {
    dismissRecent(candidate.session.id);
    syncFlowDecor(candidate.session.id);
  }
  return Boolean(jumped);
}
async function refreshRunStatus() {
  try {
    const d = await requestJson('/api/state?range=' + state.activeRange);
    state.stats = d.stats;
    renderStats();
  } catch { /* ignore */ }
}

/* ---------- 渲染：统计 / 筛选 / 活跃区 ---------- */
function renderStats() {
  $('st-today').textContent = state.stats.today ?? 0;
  $('st-total').textContent = state.stats.total ?? 0;
  $('st-active').textContent = state.stats.active ?? 0;
}
function renderChips() {
  // 6 列瀑布流自带 agent 维度，chips 仅做统计展示（不再影响列表内容）
  const box = $('agent-chips'); box.innerHTML = '';
  const cnt = { all: 0 };
  for (const s of state.board.all || []) cnt.all++;
  for (const a of state.agents) cnt[a.id] = state.board[a.id] ? state.board[a.id].length : 0;
  const all = document.createElement('button');
  all.className = 'chip on';
  all.textContent = '全部';
  box.appendChild(all);
  for (const a of state.agents) {
    const c = document.createElement('button');
    c.className = 'chip';
    c.innerHTML = `<span class="dot" style="background:${a.color}"></span>${esc(a.name)} <span style="opacity:.55">${cnt[a.id]}</span>`;
    box.appendChild(c);
  }
}
function renderProjects() {
  const sel = $('active-project');
  sel.innerHTML = '<option value="">全部项目</option>';
  for (const p of state.projects) {
    const o = document.createElement('option');
    o.value = p.project; o.textContent = `${p.project} (${p.cnt})`;
    sel.appendChild(o);
  }
  sel.value = state.activeProject;
  renderProjectRail();
}
function projectItems() {
  return state.projects
    .filter((item) => item.project)
    .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
}
function projectLeaf(project) {
  const path = String(project || '').replace(/[\\/]+$/, '');
  return path.split(/[\\/]/).pop() || String(project || '');
}
function toggleProject(project) {
  state.project = state.project === project ? '' : project;
  renderProjectRail();
  loadBoard();
}
function renderProjectRail() {
  const rail = $('project-rail');
  if (!rail) return;
  const items = projectItems();
  rail.innerHTML = '<div class="project-rail-head">全部项目</div>';
  if (!items.length) {
    rail.innerHTML += '<div class="project-empty">暂无项目路径</div>';
    return;
  }
  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'project-path' + (item.project === state.project ? ' on' : '');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'project-path-select';
    button.title = item.project;
    button.innerHTML = `<span class="project-path-short">${esc(projectLeaf(item.project))}</span><span class="project-path-full">${esc(item.project)}</span>`;
    button.onclick = () => toggleProject(item.project);
    const copyButton = document.createElement('button');
    copyButton.type = 'button';
    copyButton.className = 'project-path-copy';
    copyButton.title = '复制完整路径';
    copyButton.setAttribute('aria-label', '复制完整路径');
    copyButton.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
    copyButton.addEventListener('click', async (e) => {
      e.stopPropagation();
      const ok = await clip(item.project);
      toast(ok ? '已复制完整路径' : '复制失败，请手动复制');
    });
    row.append(button, copyButton);
    rail.appendChild(row);
  }
}
const RANGE_LABEL = { day: '当天', '24h': '近 24 小时', week: '近一周', month: '近一个月' };
function renderActive() {
  const row = $('active-row'); const title = $('active-title');
  row.innerHTML = '';
  let list = state.active || [];
  if (state.activeProject) list = list.filter((a) => a.project === state.activeProject);
  if (state.onlyUser) list = list.filter((a) => a.has_user);
  title.style.display = list.length ? 'flex' : 'none';
  $('active-label').textContent = `${RANGE_LABEL[state.activeRange] || '当天'}活跃的会话`;
  $('active-note').textContent = list.length ? `${list.length} 个` : '';
  for (const a of list) {
    const def = state.agentsDef[a.agent] || {};
    const meta = { name: def.name || a.agent, color: def.color || '#888780' };
    const card = document.createElement('div');
    card.className = 'a-card';
    card.innerHTML = `
      <div class="top"><span class="a-dot" style="background:${meta.color}"></span>
      <span class="a-name">${esc(meta.name)}</span><span class="ago">${ago(a.lastActivity)}</span></div>
      <div class="proj" title="${esc(a.title || '')}">${esc(a.title || (a.project || '（未记录项目）'))}</div>
      ${a.live ? '<span class="live"><svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="6"/></svg>进行中</span>'
               : `<span style="font-size:11px;color:var(--text3)">${esc(a.project || '')}</span>`}`;
    card.onclick = () => openSession(a.sessionRef);
    row.appendChild(card);
  }
}

/* ---------- 渲染：按 session 卡片 ---------- */
function agentMeta(id) { const d = state.agentsDef[id] || {}; return { name: d.name || id, color: d.color || '#888780' }; }
function shortProj(p) {
  const raw = String(p || '').trim();
  if (!raw) return '';
  // 卡片只显示项目路径最后一级；完整路径仍放在 title 中，鼠标悬停可查看。
  if (/^[A-Za-z]:[\\/]?$/.test(raw) || /^[/\\]+$/.test(raw)) return raw;
  const trimmed = raw.replace(/[\\/]+$/, '');
  const parts = trimmed.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || raw;
}
function topologyRoleMarkup(s, statusHtml = '') {
  const role = ['main', 'child', 'unknown'].includes(s.session_role) ? s.session_role : 'unknown';
  const labels = { main: '◎ 主会话', child: '↳ 子代理', unknown: '? 未确认' };
  const hint = s.child_detection === 'unsupported' ? '当前 agent 尚未验证子代理结构，自动控制需人工确认' : '';
  const badge = `<span class="s-topology-badge ${role}" title="${esc(hint || labels[role])}">${labels[role]}</span>`;
  let relation = '';
  if (role === 'child' && s.parent_session_ref) {
    relation = `<span class="s-topology-relation" title="${esc(s.parent_session_ref)}">父会话 ${esc(displaySessionId(s.parent_session_ref))}</span>`;
  } else if (role === 'main' && Number(s.child_count || 0) > 0) {
    relation = `<span class="s-topology-relation" title="${Number(s.active_child_count || 0)} 个子代理最近 10 分钟有活动">子代理 ${Number(s.child_count || 0)}${Number(s.active_child_count || 0) ? ` · ${Number(s.active_child_count)} 活跃` : ''}</span>`;
  }
  return badge + statusHtml + relation;
}
function resumeCommand(agent, sid) {
  if (agent === 'claude') return `claude --resume ${sid}`;
  if (agent === 'codex') return `codex resume ${sid}`;
  return '';
}
// 从 board 各组移除指定 session
function removeFromBoard(b, agent, sessionId) {
  const ref = agent + ':' + sessionId;
  const out = {};
  for (const k of Object.keys(b)) out[k] = (b[k] || []).filter((s) => s.id !== ref);
  return out;
}

/* ---------- 「刚完成」流光标记 ---------- */
// 会话刚离开活跃窗口（进行中 → 已完成）时打绿色流光 + 「已读」按钮；
// 点击「已读」→ 恢复普通已完成样式；超过 TTL 自动取消。localStorage 持久化。
const RECENT_DONE_TTL = 30 * 60 * 1000; // 高亮保留时长：30 分钟
const RECENT_DONE_STATE_VERSION = '2';
function loadRecentDone() {
  try {
    if (localStorage.getItem('ab-recent-done-version') !== RECENT_DONE_STATE_VERSION) {
      localStorage.removeItem('ab-recent-done');
      localStorage.removeItem('ab-recent-dismissed');
      localStorage.setItem('ab-recent-done-version', RECENT_DONE_STATE_VERSION);
      return;
    }
  } catch {}
  try {
    const raw = JSON.parse(localStorage.getItem('ab-recent-done') || '{}');
    const now = Date.now();
    for (const k of Object.keys(raw)) if (now - raw[k] < RECENT_DONE_TTL) state.recentDone.set(k, raw[k]);
  } catch {}
  try { state.dismissedRecent = new Set(JSON.parse(localStorage.getItem('ab-recent-dismissed') || '[]')); } catch {}
}
function persistRecentDone() {
  try {
    const obj = {}; for (const [k, v] of state.recentDone) obj[k] = v;
    localStorage.setItem('ab-recent-done', JSON.stringify(obj));
    localStorage.setItem('ab-recent-dismissed', JSON.stringify([...state.dismissedRecent]));
  } catch {}
}
function isRecentCompleted(ref) {
  const t = state.recentDone.get(ref);
  if (!t || state.dismissedRecent.has(ref)) return false;
  if (Date.now() - t > RECENT_DONE_TTL) { state.recentDone.delete(ref); persistRecentDone(); return false; }
  return true;
}
function markRecentlyCompleted(ref) {
  state.dismissedRecent.delete(ref); // 新一轮完成重新点亮，忽略之前的「已读」
  state.recentDone.set(ref, Date.now());
  persistRecentDone();
  const agent = String(ref).split(':', 1)[0];
  const role = sessionRoleForRef(ref);
  if (!isSoundRoleEnabled(state.completionSounds, agent, role)) return;
  const soundId = state.completionSounds.assignments[agent];
  const sound = state.completionSounds.sounds.find((item) => item.id === soundId);
  if (sound) playSoundPreview(sound.url);
}
function dismissRecent(ref) {
  state.recentDone.delete(ref);
  state.dismissedRecent.add(ref);
  persistRecentDone();
}
function dismissAllRecent() {
  const refs = new Set(state.recentDone.keys());
  document.querySelectorAll('#board .s-card.flow-green').forEach((el) => {
    const ref = el.querySelector('.s-more')?.dataset.ref;
    if (ref) refs.add(ref);
  });
  for (const ref of refs) {
    state.recentDone.delete(ref);
    state.dismissedRecent.add(ref);
  }
  persistRecentDone();
  document.querySelectorAll('#board .s-card').forEach((el) => {
    const ref = el.querySelector('.s-more')?.dataset.ref;
    if (ref) applyFlowDecor(el, ref, state.liveRefs.has(ref));
  });
  toast(refs.size ? `已将 ${refs.size} 个会话标记为已读` : '暂无需要标记的会话');
}
// 按最新状态刷新单张卡的流光装饰（SSE 逐卡差异更新 + 已读点击共用）
function applyFlowDecor(el, ref, nowLive) {
  const runtime = state.runtimeStatuses.get(ref);
  const recent = !nowLive && (!runtime || runtime.state === 'completed') && isRecentCompleted(ref);
  el.classList.toggle('flow-red', nowLive);
  el.classList.toggle('flow-green', recent);
  let btn = el.querySelector('.s-flow-dismiss');
  if (recent && !btn) {
    btn = document.createElement('button');
    btn.className = 's-flow-dismiss';
    btn.title = '取消「刚完成」流光高亮，恢复普通已完成样式';
    btn.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>已读';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      dismissRecent(ref);
      syncFlowDecor(ref);
      toast('已恢复普通已完成样式');
    });
    const jump = el.querySelector('.s-jump');
    // 已完成卡的操作顺序固定为：“更多” → “已读” → “跳转”。
    // 这样外部自动化使用 button[3] 时会命中跳转按钮。
    if (jump) jump.insertAdjacentElement('beforebegin', btn);
    else el.appendChild(btn);
  } else if (!recent && btn) {
    btn.remove();
  }
}
// 同一会话会在「全部」列和 agent 列各出现一次，同步所有列的流光装饰
function syncFlowDecor(ref) {
  document.querySelectorAll('#board .s-card').forEach((el) => {
    const r = el.querySelector('.s-more')?.dataset.ref;
    if (r === ref) applyFlowDecor(el, r, state.liveRefs.has(r));
  });
}

function renderBoard() {
  const board = $('board');
  const cols = effectiveCols();
  board.innerHTML = '';
  for (const key of cols) {
    const col = document.createElement('div');
    col.className = 'agent-col';
    col.dataset.col = key;
    const meta = key === 'all'
      ? { name: '全部', color: '#888780', icon: null }
      : (state.agentsDef[key] || { name: key, color: '#888780', icon: null });

    const head = document.createElement('div');
    head.className = 'col-head';
    head.style.setProperty('--colc', meta.color);
    head.innerHTML = `<span class="col-name">${esc(meta.name)}</span>`;

    const cardsBox = document.createElement('div');
    cardsBox.className = 'col-cards';
    col.appendChild(head);
    col.appendChild(cardsBox);
    board.appendChild(col);

    const list = state.board[key] || [];
    if (!list.length) {
      const empty = document.createElement('div');
      empty.className = 'col-empty';
      empty.textContent = key === 'all' ? '暂无会话' : '暂无该 agent 的会话';
      if (key !== 'all' && state.agentsDef[key]) {
        const quickOpen = document.createElement('button');
        quickOpen.type = 'button';
        quickOpen.className = 'col-empty-action';
        quickOpen.textContent = `启动 ${meta.name}`;
        quickOpen.title = `启动 ${meta.name}；如果没有窗口会自动显示恢复指引`;
        quickOpen.addEventListener('click', (e) => {
          e.stopPropagation();
          launchAgent(key);
        });
        empty.appendChild(quickOpen);
      }
      cardsBox.appendChild(empty);
      continue;
    }
    if (state.subagentCardStyle === 'stacked') {
      const groups = sessionCardStacking.groupSessions(list);
      for (const item of groups) {
        cardsBox.appendChild(item.type === 'group'
          ? buildSessionCardGroup(item, key)
          : buildCard(item.session, key));
      }
    } else {
      for (const s of list) cardsBox.appendChild(buildCard(s, key));
    }
  }
}

// 隐藏一个 Agent（从显示配置里移除；全部视图不可隐藏）
function hideCol(key) {
  if (key === 'all') { toast('「全部」列不可隐藏'); return; }
  const order = effectiveCols().filter((c) => c !== key);
  state.colOrder = order;
  saveColOrder(order);
  renderBoard();
  toast('已隐藏 ' + (agentMeta(key).name || key) + '，可在 Agent 显示设置中恢复');
}

const RUNTIME_STATUS_LABELS = {
  running: '进行中',
  waiting_approval: '待审批',
  waiting_user_input: '待输入',
  completed: '已完成',
  interrupted: '已中断',
  failed: '失败',
  stale_active: '状态待确认',
  not_loaded: '未加载',
  system_error: '系统错误',
  idle: '空闲',
  unknown: '状态未知',
};

function runtimeStatusFor(s, live) {
  const runtime = state.runtimeStatuses.get(s.id) || s.runtime_status;
  return runtime && runtime.state ? runtime.state : (live ? 'running' : 'completed');
}

function statusClass(status) {
  if (status === 'running') return 'active';
  if (status === 'waiting_approval' || status === 'waiting_user_input') return 'waiting';
  if (status === 'failed' || status === 'system_error') return 'failed';
  if (status === 'interrupted') return 'interrupted';
  if (status === 'stale_active' || status === 'not_loaded' || status === 'unknown') return 'attention';
  return 'done';
}

function statusMarkup(status) {
  const label = RUNTIME_STATUS_LABELS[status] || RUNTIME_STATUS_LABELS.unknown;
  if (status === 'running') return '<span class="s-status on"><span class="pulse"></span>' + label + '</span>';
  if (status === 'waiting_approval' || status === 'waiting_user_input') return '<span class="s-status wait">' + label + '</span>';
  if (status === 'failed' || status === 'system_error') return '<span class="s-status error">' + label + '</span>';
  if (status === 'interrupted') return '<span class="s-status interrupted">' + label + '</span>';
  if (status === 'stale_active' || status === 'not_loaded' || status === 'unknown') return '<span class="s-status attention">' + label + '</span>';
  return '<span class="s-status">' + label + '</span>';
}

function applyStatusClass(el, status) {
  for (const cls of ['active', 'waiting', 'failed', 'interrupted', 'attention', 'done']) el.classList.remove(cls);
  el.classList.add(statusClass(status));
}

function syncSubagentGroupExpansion(rootRef) {
  const expanded = state.expandedSubagentGroups.has(rootRef);
  document.querySelectorAll('#board .session-card-group').forEach((group) => {
    if (group.dataset.rootRef !== rootRef) return;
    group.classList.toggle('is-expanded', expanded);
    group.classList.toggle('is-stacked', !expanded);
    const button = group.querySelector('.s-subagent-toggle');
    if (!button) return;
    const count = Number(button.dataset.childCount || 0);
    const label = expanded ? `收拢 ${count} 个子代理` : `展开 ${count} 个子代理`;
    button.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    button.title = label;
    button.setAttribute('aria-label', label);
  });
}

function toggleSubagentGroup(rootRef) {
  if (state.expandedSubagentGroups.has(rootRef)) state.expandedSubagentGroups.delete(rootRef);
  else state.expandedSubagentGroups.add(rootRef);
  syncSubagentGroupExpansion(rootRef);
}

function workflowForSession(s) {
  return autopilotUi && typeof autopilotUi.findWorkflowForSession === 'function'
    ? autopilotUi.findWorkflowForSession(state.orchestration.workflows, s) : null;
}

function autopilotActionMarkup(workflow) {
  if (!workflow) return '';
  const stateName = workflow.autoState || 'OFF';
  const isAuto = workflow.autopilotMode === 'auto';
  const actions = [];
  if (isAuto && ['PAUSED', 'BLOCKED'].includes(stateName)) {
    actions.push('<button type="button" class="btn primary autopilot-detail-action" data-action="resume">恢复 Auto</button>');
  } else if (isAuto && !['DONE', 'STOPPED'].includes(stateName) && workflow.controlOwner !== 'human') {
    actions.push('<button type="button" class="btn autopilot-detail-action" data-action="stop">停止 Auto</button>');
  }
  if (!['completed', 'paused'].includes(workflow.status) && workflow.controlOwner !== 'human') {
    actions.push('<button type="button" class="btn autopilot-detail-action" data-action="takeover">人工接管</button>');
  }
  return actions.join('');
}

function openAutoPilotDetail(workflow) {
  if (!workflow || !autopilotUi) return;
  closePopover();
  state.popoverFor = 'autopilot-detail';
  const pop = document.createElement('div');
  pop.className = 'popover autopilot-detail';
  pop.style.position = 'fixed';
  pop.style.top = '70px';
  pop.style.right = '16px';
  pop.style.zIndex = 60;
  const latest = null;
  const detail = autopilotUi.detailForWorkflow(workflow, latest);
  const summary = autopilotUi.sessionSummary(workflow);
  const scope = detail.scope.length ? detail.scope : ['未声明'];
  const dod = detail.dod.length
    ? detail.dod.map((item) => `<li class="${item.passed ? 'done' : ''}">${item.passed ? '✓ ' : ''}${esc(item.description)}</li>`).join('')
    : '<li>未声明</li>';
  const actions = autopilotActionMarkup(workflow);
  pop.innerHTML = `<div class="autopilot-detail-head"><strong>AutoPilot 详情</strong><span class="ai-badge">${esc(summary.state || 'OFF')}</span><button type="button" class="btn autopilot-detail-close">关闭</button></div>
    <section class="autopilot-detail-section"><strong>Goal</strong><div class="autopilot-detail-copy">${esc(detail.goal)}</div></section>
    <section class="autopilot-detail-section"><strong>Scope</strong><ul class="autopilot-detail-list">${scope.map((item) => `<li>${esc(item)}</li>`).join('')}</ul></section>
    <section class="autopilot-detail-section"><strong>DoD</strong><ul class="autopilot-detail-list">${dod}</ul></section>
    <section class="autopilot-detail-section"><strong>Progress</strong><div class="autopilot-detail-progress"><span style="width:${Math.max(0, Math.min(100, detail.progress.percent))}%"></span></div><div class="autopilot-detail-meta">${esc(detail.progress.completed)}/${esc(detail.progress.total)} · ${esc(detail.progress.percent)}%</div></section>
    <section class="autopilot-detail-section"><strong>Current Model / Reasoning</strong><div class="autopilot-detail-copy">${esc(detail.currentModel)} · ${esc(detail.reasoning)}</div><div class="autopilot-detail-meta">原因：${esc(detail.routeReason)}（不展示 Chain of Thought）</div></section>
    <section class="autopilot-detail-section"><strong>Last Decision</strong><div class="autopilot-detail-copy">${esc(detail.lastDecision)}</div></section>
    <section class="autopilot-detail-section"><strong>Delivery State</strong><div class="autopilot-detail-copy">${esc(detail.deliveryState)}</div></section>
    <div class="autopilot-detail-actions">${actions || '<span class="ai-hint">当前状态无需操作</span>'}</div>`;
  document.body.appendChild(pop);
  pop.querySelector('.autopilot-detail-close').onclick = closePopover;
  pop.querySelectorAll('.autopilot-detail-action').forEach((button) => {
    button.onclick = () => {
      const action = button.dataset.action;
      closePopover();
      void runOrchestrationAction(action, workflow.id);
    };
  });
}

async function openAutoPilotForSession(s) {
  closePopover();
  const workflow = workflowForSession(s);
  if (workflow) {
    openAutoPilotDetail(workflow);
    return;
  }
  const sessionAgent = agentMeta(s.agent);
  const sessionProject = s.project || '';
  const initialGoal = String(s.last_user_text || s.title || '').trim();
  state.popoverFor = 'autopilot-fastpath';
  const pop = document.createElement('div');
  pop.className = 'popover autopilot-fastpath';
  pop.style.position = 'fixed';
  pop.style.top = '70px';
  pop.style.right = '16px';
  pop.style.zIndex = 60;
  pop.innerHTML = `<div class="autopilot-fastpath-head"><strong>AI 托管当前 Session</strong><button type="button" class="btn autopilot-fastpath-close">关闭</button></div>
    <div class="autopilot-fastpath-context"><div>Agent：<b>${esc(sessionAgent.name || s.agent || '未知')}</b>（已自动识别）</div><div>项目：<b>${esc(shortProj(sessionProject) || '未检测到项目')}</b>（已自动绑定）</div><div>Session：<b>${esc(displaySessionId(s.id))}</b></div></div>
    <form id="autopilot-fastpath-form"><label>任务目标<textarea id="autopilot-fast-goal" placeholder="描述希望当前 Session 完成的结果；也可从 PRD 提取"></textarea></label>
      <div class="autopilot-prd-controls"><label>PRD 来源<select id="autopilot-prd-mode"><option value="auto">自动判断</option><option value="current">当前项目 PRD</option><option value="manual">选择其他 PRD</option><option value="none">不使用 PRD</option></select></label>
        <label id="autopilot-prd-candidate-row" hidden>PRD 候选<select id="autopilot-prd-candidates"><option value="">请选择 PRD 版本</option></select></label>
        <label id="autopilot-prd-path-row" hidden>PRD 文件路径<input id="autopilot-prd-path" type="text" placeholder="允许目录内的 .md、.mdx 或 .txt 文件"></label></div>
      <div class="autopilot-fastpath-source"><button type="button" class="btn" id="autopilot-goal-manual">自己填写</button><button type="button" class="btn" id="autopilot-goal-prd">从 PRD 生成任务</button><button type="button" class="btn" id="autopilot-intake-preview">生成任务摘要</button></div>
      <div class="autopilot-intake-status" id="autopilot-intake-status" hidden></div>
      <div class="autopilot-prd-preview" id="autopilot-prd-preview" hidden></div>
      <div class="autopilot-fastpath-actions"><button type="button" class="btn" id="autopilot-advanced">高级设置 / 手动创建</button><button type="submit" class="btn primary" id="autopilot-fast-start">开始 AI 托管</button></div>
      <div class="autopilot-fastpath-hint">客户端不能修改 Agent、Session 或项目绑定；模式、调度、预算和安全策略使用设置中心的持久化默认值。</div></form>`;
  document.body.appendChild(pop);
  const goal = pop.querySelector('#autopilot-fast-goal');
  const prdMode = pop.querySelector('#autopilot-prd-mode');
  const prdPath = pop.querySelector('#autopilot-prd-path');
  const prdPathRow = pop.querySelector('#autopilot-prd-path-row');
  const candidateRow = pop.querySelector('#autopilot-prd-candidate-row');
  const candidateSelect = pop.querySelector('#autopilot-prd-candidates');
  const preview = pop.querySelector('#autopilot-prd-preview');
  const status = pop.querySelector('#autopilot-intake-status');
  let latestTaskContract = null;
  goal.value = initialGoal;
  goal.dataset.goalSource = initialGoal ? 'session' : 'manual';
  pop.querySelector('.autopilot-fastpath-close').onclick = closePopover;
  pop.querySelector('#autopilot-advanced').onclick = async () => {
    closePopover();
    await setMonitorMode('ai');
    $('ai-create-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  pop.querySelector('#autopilot-goal-manual').onclick = () => {
    goal.dataset.goalSource = 'manual';
    prdMode.value = 'none';
    syncPrdControls();
    goal.focus();
  };

  function syncPrdControls() {
    prdPathRow.hidden = prdMode.value !== 'manual';
    if (prdMode.value !== 'manual') candidateRow.hidden = true;
    latestTaskContract = null;
  }

  function setIntakeStatus(message, kind = '') {
    status.hidden = !message;
    status.className = `autopilot-intake-status${kind ? ` ${kind}` : ''}`;
    status.textContent = message || '';
  }

  function showCandidates(candidates) {
    const items = Array.isArray(candidates) ? candidates : [];
    candidateSelect.innerHTML = `<option value="">${items.length ? '请选择 PRD 版本' : '未找到可用 PRD'}</option>${items.map((item) => `<option value="${esc(item.path)}">${esc(item.name)}${item.version ? ` · ${esc(item.version)}` : ''}</option>`).join('')}`;
    candidateRow.hidden = false;
  }

  function renderTaskContract(contract, warning = '') {
    const view = autopilotUi.taskContractView(contract);
    const confidence = `${Math.round(view.confidence * 100)}%`;
    const sections = view.sections.map((section) => `<section class="autopilot-contract-section"><strong>${esc(section.label)}</strong>${section.items.length ? `<ul>${section.items.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>` : '<div class="autopilot-contract-empty">待补充</div>'}</section>`).join('');
    const gate = view.humanGate.required
      ? `<div class="autopilot-human-gate"><strong>需要人工审批</strong><div>${esc(view.humanGate.reason || '高风险任务不会自动执行')}</div></div>` : '';
    preview.hidden = false;
    preview.innerHTML = `<div class="autopilot-contract-head"><strong>${esc(view.kindLabel)}</strong><span>置信度 ${esc(confidence)}</span></div>
      <div class="autopilot-contract-goal"><b>Goal</b><div>${esc(view.goal || '待补充')}</div></div>
      ${view.sourceLabel ? `<div class="autopilot-contract-source">来源：${esc(view.sourceLabel)}</div>` : ''}${sections}${gate}
      ${view.missingFields.length ? `<small>待补字段：${esc(view.missingFields.join('、'))}</small>` : ''}
      ${warning ? `<small>${esc(warning)}</small>` : ''}`;
  }

  async function previewTask() {
    setIntakeStatus('正在分析任务…', 'loading');
    latestTaskContract = null;
    const body = { sessionRef: s.id, goal: goal.value.trim(), prdMode: prdMode.value };
    if (prdMode.value === 'manual') body.prdPath = prdPath.value.trim();
    try {
      const data = await requestJson('/api/orchestration/intake/preview', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, allowFailure: true,
        body: JSON.stringify(body),
      });
      if (!data.ok) {
        if (data.code === 'PRD_SELECTION_REQUIRED') {
          showCandidates(data.candidates);
          setIntakeStatus('发现多个 PRD，请选择要使用的版本。', 'error');
        } else if (data.code === 'PRD_NOT_FOUND') {
          showCandidates([]);
          setIntakeStatus('未找到可用 PRD，请选择其他文件或自己填写任务。', 'error');
        } else {
          setIntakeStatus(data.error || '任务分析失败', 'error');
        }
        const error = new Error(data.error || '任务分析失败');
        error.code = data.code;
        throw error;
      }
      latestTaskContract = data.taskContract;
      renderTaskContract(data.taskContract, data.warning);
      setIntakeStatus('任务摘要已生成，请确认后继续。', 'success');
      return data;
    } catch (error) {
      if (!status.textContent || status.classList.contains('loading')) setIntakeStatus(error.message || '任务分析失败', 'error');
      throw error;
    }
  }

  prdMode.onchange = syncPrdControls;
  candidateSelect.onchange = () => {
    if (!candidateSelect.value) return;
    prdMode.value = 'manual';
    prdPath.value = candidateSelect.value;
    prdPathRow.hidden = false;
    latestTaskContract = null;
  };
  goal.oninput = () => { latestTaskContract = null; };
  prdPath.oninput = () => { latestTaskContract = null; };
  pop.querySelector('#autopilot-intake-preview').onclick = () => {
    void previewTask().catch((error) => toast(error.message || '任务分析失败'));
  };
  pop.querySelector('#autopilot-goal-prd').onclick = async () => {
    const button = pop.querySelector('#autopilot-goal-prd');
    button.disabled = true;
    button.textContent = '正在分析任务…';
    if (prdMode.value === 'auto' || prdMode.value === 'none') prdMode.value = 'current';
    syncPrdControls();
    try {
      const data = await previewTask();
      if (data.taskContract?.goal) {
        goal.value = data.taskContract.goal;
        goal.dataset.goalSource = 'prd';
      }
      toast('已从 PRD 生成任务摘要，请确认后继续');
      goal.focus();
    } catch (error) {
      toast(error.message || 'PRD 任务生成失败');
    } finally {
      button.disabled = false;
      button.textContent = '从 PRD 生成任务';
    }
  };
  pop.querySelector('#autopilot-fastpath-form').onsubmit = async (event) => {
    event.preventDefault();
    const start = pop.querySelector('#autopilot-fast-start');
    start.disabled = true;
    try {
      const intake = latestTaskContract ? { taskContract: latestTaskContract } : await previewTask();
      if (!goal.value.trim() && intake.taskContract?.goal) {
        goal.value = intake.taskContract.goal;
        goal.dataset.goalSource = 'prd';
      }
      const requestBody = { sessionRef: s.id, goal: goal.value.trim(), goalSource: goal.dataset.goalSource || 'manual', prdMode: prdMode.value };
      if (prdMode.value === 'manual') requestBody.prdPath = prdPath.value.trim();
      const data = await requestJson('/api/orchestration/workflows/from-session', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });
      if (data.workflow?.autopilotMode === 'auto' && !data.requiresApproval) {
        await requestJson(`/api/orchestration/workflows/${encodeURIComponent(data.workflow.id)}/run`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
        });
      }
      closePopover();
      if (data.bypass) toast('任务已判断为直接处理，无需创建复杂 Workflow');
      else if (data.requiresApproval) toast('高风险任务已暂停，等待人工审批');
      else toast('已开始托管当前 Session');
      await loadOrchestration();
    } catch (error) {
      start.disabled = false;
      if (error.code !== 'PRD_SELECTION_REQUIRED') toast(error.message || 'AI 托管启动失败');
    }
  };
  syncPrdControls();
  goal.focus();
}

function buildSessionCardGroup(group, colKey) {
  const expanded = state.expandedSubagentGroups.has(group.root.id);
  const childCount = group.children.length;
  const wrapper = document.createElement('div');
  wrapper.className = 'session-card-group ' + (expanded ? 'is-expanded' : 'is-stacked');
  wrapper.dataset.rootRef = group.root.id;
  wrapper.appendChild(buildCard(group.root, colKey, { expanded, childCount }));

  const children = document.createElement('div');
  children.className = 'session-card-children';
  for (const [index, child] of group.children.entries()) {
    const childCard = buildCard(child, colKey);
    childCard.classList.add('stack-child-card');
    childCard.style.setProperty('--stack-index', String(index + 1));
    children.appendChild(childCard);
  }
  wrapper.appendChild(children);
  return wrapper;
}

function buildCard(s, colKey, groupContext = null) {
  const meta = agentMeta(s.agent);
  const def = state.agentsDef[s.agent] || {};
  // 状态唯一权威来源：liveRefs（SSE 实时维护），不用后端快照 s.status——
  // 后端 status 在请求瞬间计算，心跳窗口边缘可能算成 done，重建时会把进行中闪回已完成
  const live = state.liveRefs.has(s.id);
  const status = runtimeStatusFor(s, live);
  const recent = status === 'completed' && !live && isRecentCompleted(s.id);
  const card = document.createElement('div');
  const topologyRole = ['main', 'child', 'unknown'].includes(s.session_role) ? s.session_role : 'unknown';
  card.className = 's-card ' + statusClass(status) + ` topology-${topologyRole}` + (live ? ' flow-red' : '') + (recent ? ' flow-green' : '');
  card.dataset.live = live ? '1' : '0'; // 记录当前状态，供 SSE 差异化更新对比
  card.dataset.runtimeStatus = status;
  card.dataset.topologyRole = topologyRole;
  const rawSessionId = String(s.session_id || '');
  const sessionId = s.agent === 'codex' ? extractCodexThreadId(rawSessionId) : rawSessionId;
  card.dataset.sessionId = sessionId || rawSessionId;
  card.dataset.boardSessionId = rawSessionId;
  const isAll = colKey === 'all';
  const lastCmd = (s.last_user_text || '（暂无用户指令）').replace(/\s+/g, ' ').slice(0, 160);
  const titleHtml = `<span class="s-title" title="${esc(s.title)}">${esc(s.title || rawSessionId.slice(0, 12))}</span>`;
  const sessionIdLabel = displaySessionId(sessionId);
  const sessionIdHtml = sessionId
    ? `<button type="button" class="s-sid" data-session-id="${esc(sessionId)}" title="复制 ${esc(s.agent === 'codex' ? 'Codex thread ID' : 'session ID')}">${esc(sessionIdLabel)}</button>`
    : '';
  const agentTag = isAll
    ? `<span class="agent-tag" style="background:${meta.color}">${esc(meta.name)}</span>`
    : '';
  const statusHtml = statusMarkup(status);
  const autopilotWorkflow = typeof workflowForSession === 'function' ? workflowForSession(s) : null;
  const autopilotSummary = typeof autopilotUi !== 'undefined' && autopilotUi && autopilotUi.sessionSummary
    ? autopilotUi.sessionSummary(autopilotWorkflow) : { kind: 'setup', label: 'AI 托管', title: '仅托管当前 Session 和项目' };
  const autopilotButton = `<button type="button" class="s-autopilot ${esc(autopilotSummary.kind)}" data-action="autopilot" aria-label="${esc(autopilotSummary.title)}" title="${esc(autopilotSummary.title)}">🤖 ${esc(autopilotSummary.label)}</button>`;
  // 跳转图标：优先用 AGENT_DEFS 里的 logo，否则 fallback 到字母
  const iconHtml = def.icon
    ? `<img src="/icons/${esc(def.icon)}" alt="" style="width:18px;height:18px;object-fit:contain">`
    : `<span style="font-size:12px;font-weight:700;color:${meta.color}">${esc((meta.name||'?').charAt(0))}</span>`;
  const subagentToggleHtml = groupContext
    ? `<button type="button" class="s-subagent-toggle" data-child-count="${groupContext.childCount}" aria-label="${groupContext.expanded ? '收拢' : '展开'} ${groupContext.childCount} 个子代理" aria-expanded="${groupContext.expanded ? 'true' : 'false'}" title="${groupContext.expanded ? '收拢' : '展开'} ${groupContext.childCount} 个子代理">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
      </button>`
    : '';
  card.innerHTML = `
    <div class="s-row1">
      ${topologyRoleMarkup(s, statusHtml)}
      ${autopilotButton}
    </div>
    <div class="s-title-row">
      <div class="s-title-leading">
        ${agentTag}
        ${titleHtml}
      </div>
    </div>
    <div class="s-proj" title="${esc(s.project)}">${esc(shortProj(s.project) || '（无项目路径）')}</div>
    <div class="s-cmd" title="${esc(lastCmd)}">▸ ${esc(lastCmd)}</div>
    <div class="s-row2">
      <span class="s-msg">${s.msg_count} 条</span>
      <span class="s-time">${fmtTimeLabel(s.last_seen)}</span>
      ${sessionIdHtml}
    </div>
    <div class="s-actions">
      <button class="s-more" data-action="session-menu" data-ref="${esc(s.id)}" title="更多操作">···</button>
      ${subagentToggleHtml}
      ${recent ? '<button class="s-flow-dismiss" title="取消「刚完成」流光高亮，恢复普通已完成样式"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>已读</button>' : ''}
      <button type="button" class="s-jump" data-action="jump-session" data-ref="${esc(s.id)}" data-session-id="${esc(sessionId)}" data-agent="${esc(s.agent)}" aria-label="跳转到 ${esc(meta.name||s.agent)}" title="跳转到 ${esc(meta.name||s.agent)}">
        ${iconHtml}
      </button>
    </div>
    `;
  if (groupContext) card.classList.add('has-subagent-toggle', 'stack-main-card');
  card.addEventListener('click', (e) => {
    if (e.target.closest('.s-jump') || e.target.closest('.s-more') || e.target.closest('.s-flow-dismiss') || e.target.closest('.s-subagent-toggle') || e.target.closest('.s-autopilot')) return;
    openSession(s.id);
  });
  card.querySelector('.s-jump').addEventListener('click', (e) => {
    e.stopPropagation();
    Promise.resolve(jumpToAgentSession(s)).then((jumped) => {
      // 只有确认跳转成功，才把「刚完成」卡片标记为已读。
      if (jumped && isRecentCompleted(s.id)) {
        dismissRecent(s.id);
        syncFlowDecor(s.id);
      }
    });
  });
  card.querySelector('.s-sid')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    const value = e.currentTarget.dataset.sessionId || '';
    const ok = await clip(value);
    toast(ok ? `已复制 session ID：${value}` : '复制 session ID 失败');
  });
  card.querySelector('.s-more').addEventListener('click', (e) => {
    e.stopPropagation();
    openPopover(s, e.currentTarget);
  });
  card.querySelector('.s-flow-dismiss')?.addEventListener('click', (e) => {
    e.stopPropagation();
    dismissRecent(s.id);
    syncFlowDecor(s.id);
    toast('已恢复普通已完成样式');
  });
  card.querySelector('.s-subagent-toggle')?.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleSubagentGroup(s.id);
  });
  card.querySelector('.s-autopilot')?.addEventListener('click', (e) => {
    e.stopPropagation();
    void openAutoPilotForSession(s);
  });
  return card;
}

/* ---------- 更多操作弹菜单 ---------- */
function openPopover(s, anchorEl) {
  closePopover();
  state.popoverFor = s.id;
  const meta = agentMeta(s.agent);
  const cmd = resumeCommand(s.agent, s.session_id);
  const hasResume = !!cmd;
  const pop = document.createElement('div');
  pop.className = 'popover';
  pop.innerHTML = `
    <div class="pop-head"><span class="dot" style="background:${meta.color}"></span>${esc(meta.name)} · 更多操作</div>
    <button class="pop-item" data-act="copy-cmd" ${hasResume ? '' : 'disabled'}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
      <span>${hasResume ? '复制恢复命令' : '该 agent 无 CLI 恢复命令'}</span>
    </button>
    <button class="pop-item" data-act="open-term" ${hasResume && s.project ? '' : 'disabled'}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 17l6-6-6-6"/><path d="M12 19h8"/></svg>
      <span>${hasResume && s.project ? '打开终端并自动恢复' : (s.project ? '该 agent 无 CLI 恢复' : '缺少项目路径')}</span>
    </button>
    <button class="pop-item" data-act="copy-path" ${s.project ? '' : 'disabled'}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
      <span>${s.project ? '复制项目路径' : '无项目路径'}</span>
    </button>
    <button class="pop-item" data-act="set-status">
      ${s.manual_done
        ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg><span>恢复自动判定（取消手动完成）</span>'
        : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="M22 4L12 14.01l-3-3"/></svg><span>标记为已完成（关闭心跳）</span>'}
    </button>
    <button class="pop-item" data-act="hide">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><path d="M3 3l18 18"/></svg>
      <span>隐藏此会话（不在看板显示）</span>
    </button>`;
  const r = anchorEl.getBoundingClientRect();
  pop.style.position = 'fixed';
  pop.style.top = (r.bottom + 6) + 'px';
  pop.style.right = (window.innerWidth - r.right) + 'px';
  pop.style.zIndex = 60;
  document.body.appendChild(pop);

  pop.addEventListener('click', async (e) => {
    const item = e.target.closest('.pop-item');
    if (!item || item.disabled) return;
    const act = item.dataset.act;
    if (act === 'copy-cmd') { await clip(cmd); toast('已复制：' + cmd); closePopover(); }
    else if (act === 'open-term') {
      try {
        await requestJson('/api/open-with', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agent: s.agent, sessionId: s.session_id, project: s.project }) });
        toast('已开新终端并执行恢复命令');
      } catch (error) { toast(`打开失败：${error.message || '请求失败'}`); }
      closePopover();
    }
    else if (act === 'copy-path') { await clip(s.project); toast('已复制：' + s.project); closePopover(); }
    else if (act === 'set-status') {
      const target = s.manual_done ? 'auto' : 'done';
      try {
        await requestJson('/api/set-status', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agent: s.agent, sessionId: s.session_id, status: target }) });
        toast(target === 'done' ? '已标记为已完成，心跳已关闭' : '已恢复自动判定');
        closePopover();
        loadBoard();
        loadState();
      } catch (error) { toast(`操作失败：${error.message || '请求失败'}`); closePopover(); }
    }
    else if (act === 'hide') {
      try {
        await requestJson('/api/hide', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agent: s.agent, sessionId: s.session_id }) });
        state.board = removeFromBoard(state.board, s.agent, s.session_id);
        renderBoard();
        renderChips();
        toast('已隐藏，可在顶栏「隐藏」图标恢复');
      } catch (error) { toast(`操作失败：${error.message || '请求失败'}`); }
      closePopover();
    }
  });
}
function closePopover() {
  if (state.popoverFor === 'theme-settings' && themeManager) themeManager.cancelPreview();
  document.querySelectorAll('.popover').forEach((n) => n.remove());
  state.popoverFor = null;
}
document.addEventListener('click', (e) => {
  if (state.popoverFor && !e.target.closest('.popover') && !e.target.closest('.s-more') && !e.target.closest('#btn-hidden') && !e.target.closest('#btn-settings-hub') && !e.target.closest('#btn-agents') && !e.target.closest('#btn-logout')) closePopover();
});

/* ---------- 详情抽屉 ---------- */
// 抽屉增强：回合分组、过滤、排序、搜索、锚点导航、复制、跳转
let drawerState = { rounds: [], mode: 'all', order: 'desc', term: '', anchorsVisible: true };
async function openSession(ref) {
  if (!ref) { toast('无效的会话引用'); return; }
  try {
    const s = await requestJson('/api/session/' + encodeURIComponent(ref));
    if (!s || s.error || !s.messages) { toast(s.error || '会话数据无效'); return; }
    const meta = agentMeta(s.agent);
    // Header：保留
    $('drawer-head').innerHTML = `
      <div class="row">
        <span class="agent-tag" style="background:${meta.color}">${esc(meta.name)}</span>
        ${topologyRoleMarkup(s)}
        <span style="font-size:12px;color:var(--text2)">${s.msg_count} 条消息 · ${roundCount(s.messages)} 回合</span>
        <span style="font-size:12px;color:var(--text3);margin-left:auto">${esc(s.first_seen ? fmtDayFull(s.first_seen).slice(0,16) : '')}</span>
        <button class="icon-btn" id="d-close" style="width:32px;height:32px" title="关闭">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      </div>
      <h2>${esc(s.title || s.session_id || '未命名会话')}</h2>
      <div style="font-size:12px;color:var(--text3);word-break:break-all">
        ${esc(s.project || '')} · ${esc(meta.name)} · ${esc(s.session_id.slice(0,12))}
        ${s.parent_session_ref ? ` · 父会话 ${esc(displaySessionId(s.parent_session_ref))}` : ''}
      </div>`;
    // Body：工具栏 + 主区（锚点 + 回合流）
    const body = $('drawer-body'); body.innerHTML = '';
    body.classList.add('d-body-rich');
    const toolbar = document.createElement('div');
    toolbar.className = 'd-toolbar';
    toolbar.innerHTML = `
      <div class="d-tabs">
        <button class="d-tab on" data-f="all">全部 <span class="d-cnt" data-cnt="all">0</span></button>
        <button class="d-tab" data-f="user">我的指令 <span class="d-cnt" data-cnt="user">0</span></button>
        <button class="d-tab" data-f="assistant">AI 回复 <span class="d-cnt" data-cnt="assistant">0</span></button>
      </div>
      <div class="d-spacer"></div>
      <input class="d-search" placeholder="搜索消息…">
      <button class="d-icon-btn d-sort" title="切换顺序">↓ 倒序</button>
      <button class="d-icon-btn d-copy" title="复制全部为 Markdown">⧉ 复制</button>
      <button class="d-icon-btn d-jump" title="跳转到该应用窗口">→ 跳转</button>
    `;
    body.appendChild(toolbar);
    const main = document.createElement('div');
    main.className = 'd-main';
    body.appendChild(main);
    // 过滤无效消息、构造回合
    const filtered = s.messages.filter((m) => m.kind !== 'heartbeat' && m.kind !== 'title' && m.text);
    const rounds = buildRounds(filtered);
    drawerState = { rounds, mode: 'all', order: 'desc', term: '', sessionMeta: { ...s, agentMeta: meta } };
    main.innerHTML = `
      <aside class="d-anchors"><div class="d-anchors-head">我的指令</div><div class="d-anchors-list"></div></aside>
      <div class="d-flow"></div>
    `;
    // 渲染 + 绑定事件
    drawCounts();
    renderDrawer();
    bindDrawerEvents(s);
    $('drawer').classList.add('open');
    $('mask').classList.add('open');
    $('d-close').onclick = closeDrawer;
  } catch (e) { console.error('[openSession] failed:', ref, e); toast('会话加载失败：' + (e.message || e)); }
}
function roundCount(msgs) {
  let n = 0;
  for (const m of msgs) if (m.role === 'user' && !m.kind?.match(/heartbeat|title/)) n++;
  return n;
}
// 把消息流切成回合：以 user 消息开头，到下一条 user 消息为止
function buildRounds(msgs) {
  const rounds = [];
  let cur = null;
  for (const m of msgs) {
    const isUser = m.role === 'user';
    if (isUser) {
      if (cur) rounds.push(cur);
      cur = { user: m, replies: [] };
    } else {
      if (!cur) cur = { user: null, replies: [] };
      cur.replies.push(m);
    }
  }
  if (cur) rounds.push(cur);
  return rounds;
}
function drawCounts() {
  const all = drawerState.rounds.length;
  let user = 0, ai = 0;
  for (const r of drawerState.rounds) {
    if (r.user) user++;
    ai += r.replies.filter((m) => m.role !== 'summary').length;
  }
  $('drawer-body')?.querySelector('[data-cnt="all"]') && (document.querySelector('.d-tab[data-f="all"] .d-cnt').textContent = all);
  document.querySelector('.d-tab[data-f="user"] .d-cnt').textContent = user;
  document.querySelector('.d-tab[data-f="assistant"] .d-cnt').textContent = ai;
}
function renderDrawer() {
  const s = drawerState;
  const flow = document.querySelector('.d-flow');
  const anchors = document.querySelector('.d-anchors-list');
  if (!flow || !anchors) return;
  flow.innerHTML = ''; anchors.innerHTML = '';
  let rounds = s.rounds.slice();
  if (s.order === 'desc') rounds.reverse();
  const term = s.term.toLowerCase();
  // 过滤模式：user 只显示 user msg；assistant 只显示 replies；all 都显示
  let visible = 0;
  for (let i = 0; i < rounds.length; i++) {
    const r = rounds[i];
    if (!r.user) continue;
    const matchTerm = !term || (r.user.text || '').toLowerCase().includes(term) || r.replies.some((m) => (m.text || '').toLowerCase().includes(term));
    if (term && !matchTerm) continue;
    visible++;
    // 锚点
    const a = document.createElement('div');
    a.className = 'd-anchor';
    a.dataset.idx = String(i);
    const label = smartTitle(r.user.text || '').slice(0, 22) || (r.user.text || '').slice(0, 22) || '指令';
    a.innerHTML = `<span class="d-anchor-time">${fmtClock(r.user.ts)}</span><span class="d-anchor-text">${esc(label)}</span>`;
    a.onclick = () => {
      const el = flow.querySelector(`[data-round="${i}"]`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      document.querySelectorAll('.d-anchor.on').forEach((x) => x.classList.remove('on'));
      a.classList.add('on');
    };
    anchors.appendChild(a);
    // 回合
    const round = document.createElement('div');
    round.className = 'd-round';
    round.dataset.round = String(i);
    const showUser = s.mode !== 'assistant';
    const showReplies = s.mode !== 'user';
    round.innerHTML = `
      <div class="d-round-head" data-toggle>
        <span class="d-role-tag user">你</span>
        <span class="d-time">${fmtClock(r.user.ts)} · ${esc((r.user.text || '').slice(0, 70))}</span>
        <span class="d-round-cnt">${r.replies.length} 条回复</span>
        <span class="d-round-toggle">▾</span>
      </div>
      ${showUser ? `<div class="d-msg user${term && (r.user.text||'').toLowerCase().includes(term) ? ' match' : ''}"><div class="d-meta"><b>你</b><span>${fmtDayFull(r.user.ts)}</span></div><div class="d-text">${esc(r.user.text || '')}</div></div>` : ''}
      ${showReplies ? '<div class="d-round-replies">' + r.replies.map((m) => {
        const cls = m.role === 'summary' ? 'summary' : 'assistant';
        const isMatch = term && (m.text || '').toLowerCase().includes(term);
        return `<div class="d-msg ${cls}${isMatch ? ' match' : ''}"><div class="d-meta"><b>${m.role === 'summary' ? '会话总结' : 'AI'}</b><span>${fmtDayFull(m.ts)}</span><button class="d-msg-copy" data-copy="${esc(m.text || '')}">⧉</button></div><div class="d-text">${esc(m.text || '')}</div></div>`;
      }).join('') + '</div>' : ''}
    `;
    // 点击 head 折叠/展开
    round.querySelector('.d-round-head').onclick = () => round.classList.toggle('collapsed');
    flow.appendChild(round);
  }
  if (!visible) {
    flow.innerHTML = '<div class="d-empty">没有匹配的消息</div>';
    anchors.innerHTML = '<div class="d-anchor-empty">无</div>';
  }
  // 单条消息复制
  flow.querySelectorAll('.d-msg-copy').forEach((b) => {
    b.onclick = async (e) => {
      e.stopPropagation();
      const t = b.dataset.copy;
      await navigator.clipboard.writeText(t);
      toast('已复制单条消息');
    };
  });
  // 滚动监听：自动高亮当前可见锚点
  if (s._scrollHandler) flow.removeEventListener('scroll', s._scrollHandler);
  s._scrollHandler = () => {
    const rect = flow.getBoundingClientRect();
    let cur = -1;
    flow.querySelectorAll('.d-round').forEach((el) => {
      if (el.getBoundingClientRect().top - rect.top < 60) cur = Number(el.dataset.round);
    });
    if (cur >= 0) {
      document.querySelectorAll('.d-anchor.on').forEach((x) => x.classList.remove('on'));
      const a = anchors.querySelector(`.d-anchor[data-idx="${cur}"]`);
      if (a) a.classList.add('on');
    }
  };
  flow.addEventListener('scroll', s._scrollHandler);
}
function bindDrawerEvents(s) {
  const body = $('drawer-body');
  // 只在嵌套滚动区已到边界时截住滚轮，避免继续滚动页面底层的瀑布流。
  body.querySelectorAll('.d-anchors, .d-flow').forEach((panel) => {
    panel.addEventListener('wheel', (event) => {
      if (window.ScrollContainment.shouldContainWheel(panel, event.deltaY)) event.preventDefault();
    }, { passive: false });
  });
  // Tab 过滤
  body.querySelectorAll('.d-tab').forEach((tab) => {
    tab.onclick = () => {
      body.querySelectorAll('.d-tab').forEach((t) => t.classList.remove('on'));
      tab.classList.add('on');
      drawerState.mode = tab.dataset.f;
      renderDrawer();
    };
  });
  // 排序
  body.querySelector('.d-sort').onclick = () => {
    drawerState.order = drawerState.order === 'desc' ? 'asc' : 'desc';
    const btn = body.querySelector('.d-sort');
    btn.textContent = drawerState.order === 'desc' ? '↓ 倒序' : '↑ 正序';
    renderDrawer();
  };
  // 搜索
  const search = body.querySelector('.d-search');
  let st;
  search.addEventListener('input', () => {
    clearTimeout(st);
    st = setTimeout(() => { drawerState.term = search.value.trim(); renderDrawer(); }, 250);
  });
  // 复制全部
  body.querySelector('.d-copy').onclick = async () => {
    const md = buildMarkdown(s);
    await navigator.clipboard.writeText(md);
    toast('已复制 Markdown 到剪贴板');
  };
  // 跳转
  body.querySelector('.d-jump').onclick = () => jumpToAgentSession(s);
}
function buildMarkdown(s) {
  const lines = [`# ${s.title || s.session_id}`, '', `- Agent: ${s.agent}`, `- Project: ${s.project || '(无)'}`, `- Messages: ${s.msg_count}`, ''];
  for (const r of drawerState.rounds) {
    if (r.user) lines.push(`## ${fmtDayFull(r.user.ts)} — 你`, '', r.user.text || '', '');
    for (const m of r.replies) {
      lines.push(`### ${fmtDayFull(m.ts)} — ${m.role === 'summary' ? '总结' : 'AI'}`, '', m.text || '', '');
    }
  }
  return lines.join('\n');
}
function closeDrawer() {
  $('drawer').classList.remove('open');
  $('mask').classList.remove('open');
}

/* ---------- 导入 ---------- */
function toggleImport() {
  const box = $('import-box');
  box.style.display = box.style.display === 'none' ? 'flex' : 'none';
}
$('btn-import').onclick = toggleImport;
$('btn-dismiss-recent').onclick = dismissAllRecent;
$('imp-cancel').onclick = toggleImport;
$('imp-submit').onclick = async () => {
  const raw = $('imp-json').value.trim();
  if (!raw) { toast('请粘贴对话 JSON'); return; }
  let messages;
  try {
    messages = JSON.parse(raw);
    if (!Array.isArray(messages)) throw new Error('必须是数组');
  } catch { toast('JSON 格式错误，请检查'); return; }
  try {
    const d = await requestJson('/api/import', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent: $('imp-agent').value.trim() || 'other',
        title: $('imp-title').value.trim(),
        project: $('imp-project').value.trim(),
        messages,
      }),
    });
    toast(`已导入 ${d.imported} 条消息`);
    if (d.imported > 0) { toggleImport(); $('imp-json').value = ''; loadState(); loadBoard(); }
  } catch (error) { toast(`导入失败：${error.message || '请求失败'}`); }
};

/* ---------- 过滤交互 ---------- */
let qTimer = null;
$('f-q').addEventListener('input', (e) => {
  clearTimeout(qTimer);
  qTimer = setTimeout(() => { state.q = e.target.value.trim(); loadBoard(); }, 400);
});
$('f-onlyuser').addEventListener('change', (e) => {
  state.onlyUser = e.target.value === '1';
  loadBoard();       // 看板按过滤重载
  renderActive();    // 顶部活跃区同步过滤（数据已在 state.active 中）
});
$('f-range').addEventListener('change', (e) => { state.range = Number(e.target.value); loadBoard(); });
$('active-project').addEventListener('change', (e) => { state.activeProject = e.target.value; renderActive(); });
$('active-range').addEventListener('change', (e) => {
  state.activeRange = e.target.value;
  loadState();
});
$('btn-rescan').onclick = async () => {
  toast('开始重新扫描数据源，完成后自动刷新…');
  try {
    await requestJson('/api/rescan', { method: 'POST' });
    // 后端已异步后台扫描：响应立即返回，board 由 SSE 'scan' finished 事件自动刷新
    toast('扫描已在后台进行…');
  } catch (error) { toast(`扫描请求失败：${error.message || '请检查服务'}`); }
};
$('mask').onclick = closeDrawer;

/* ---------- 已隐藏会话管理 ---------- */
async function openHiddenManager() {
  closePopover();
  state.popoverFor = 'hidden';
  const pop = document.createElement('div');
  pop.className = 'popover';
  pop.style.position = 'fixed';
  pop.style.top = '70px';
  pop.style.right = '16px';
  pop.style.zIndex = 60;
  pop.style.minWidth = '290px';
  pop.style.maxHeight = '70vh';
  pop.style.overflowY = 'auto';
  document.body.appendChild(pop);
  try {
    const d = await requestJson('/api/hidden');
    let html = `<div class="pop-head">已隐藏的会话 <span style="opacity:.5;font-weight:400">（点恢复即重新显示）</span></div>`;
    if (!d.items.length) html += `<div style="padding:12px 14px;color:var(--text3);font-size:13px">暂无隐藏的会话</div>`;
    for (const h of d.items) {
      const color = (state.agentsDef[h.agent] || {}).color || '#888780';
      const name = (state.agentsDef[h.agent] || {}).name || h.agent;
      html += `<div class="pop-item hidden-item" data-agent="${esc(h.agent)}" data-sid="${esc(h.session_id)}" style="display:flex;align-items:center;justify-content:space-between;gap:10px">
        <span class="hi-info" style="display:flex;align-items:center;gap:8px;min-width:0"><span class="dot" style="background:${color}"></span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(name)} · ${esc(h.session_id.slice(0, 10))}…</span></span>
        <button class="hi-restore" data-agent="${esc(h.agent)}" data-sid="${esc(h.session_id)}" style="flex:none;padding:3px 10px;font-size:12px;border:1px solid var(--border);border-radius:6px;background:var(--card);color:var(--text);cursor:pointer">恢复</button>
      </div>`;
    }
    pop.innerHTML = html;
    pop.querySelectorAll('.hi-restore').forEach((b) => b.addEventListener('click', async (e) => {
      e.stopPropagation();
      const agent = b.dataset.agent, sid = b.dataset.sid;
      try {
        await requestJson('/api/unhide', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agent, sessionId: sid }) });
        const item = b.closest('.hidden-item'); if (item) item.remove();
        toast('已恢复，看板将重新显示该会话');
        loadBoard();
      } catch (error) { toast(`恢复失败：${error.message || '请求失败'}`); }
    }));
  } catch (error) { pop.innerHTML = `<div style="padding:12px;color:var(--text3)">加载失败：${esc(error.message || '请求失败')}</div>`; }
}
$('btn-hidden').onclick = openHiddenManager;
$('btn-logout').onclick = logoutFromBoard;

/* ---------- 设置面板（集中入口） ---------- */
function themeOptionMarkup(theme, selectedTheme, resolvedTheme, previewTheme) {
  const activeTheme = previewTheme || selectedTheme;
  const selected = theme.id === activeTheme;
  const preview = theme.preview || {};
  const description = theme.id === 'system'
    ? `${theme.description} 当前：${resolvedTheme === 'dark' ? '深色' : '浅色'}`
    : theme.description;
  const status = selected ? `<span class="theme-option-status">${previewTheme ? '预览中' : '当前使用'}</span>` : '';
  return `<button type="button" class="theme-option${selected ? ' selected' : ''}" data-theme-id="${esc(theme.id)}" aria-pressed="${selected ? 'true' : 'false'}">
    <span class="theme-preview" aria-hidden="true" style="--preview-background:${esc(preview.background || 'var(--background)')};--preview-surface:${esc(preview.surface || 'var(--surface)')};--preview-primary:${esc(preview.primary || 'var(--primary)')}"></span>
    <span><span class="theme-option-name">${esc(theme.name)}</span><span class="theme-option-description">${esc(description || '')}</span>${status}</span>
  </button>`;
}

function renderThemeSettings(pop) {
  if (!themeManager) {
    pop.innerHTML = '<div class="pop-head">主题设置</div><div class="theme-settings-copy">主题服务未加载，请重新打开应用。</div>';
    return;
  }
  const selectedTheme = themeManager.getSelectedTheme();
  const previewTheme = themeManager.getPreviewTheme();
  const resolvedTheme = themeManager.getResolvedTheme();
  const themes = themeManager.getAvailableThemes();
  pop.className = 'popover theme-settings';
  pop.innerHTML = `<div class="pop-head">主题设置</div>
    <div class="theme-settings-copy">选择 Agent Board 的界面主题，也可以跟随系统自动匹配浅色或深色模式。</div>
    <div class="theme-options" role="group" aria-label="界面主题">${themes.map((theme) => themeOptionMarkup(theme, selectedTheme, resolvedTheme, previewTheme)).join('')}</div>
    <div class="theme-actions">
      <button type="button" class="btn" id="theme-cancel">取消</button>
      <button type="button" class="btn primary" id="theme-apply">确定</button>
    </div>`;
  pop.querySelectorAll('.theme-option').forEach((button) => {
    button.onclick = (event) => {
      event.stopPropagation();
      themeManager.previewTheme(button.dataset.themeId);
      renderThemeSettings(pop);
    };
  });
  pop.querySelector('#theme-cancel').onclick = () => {
    themeManager.cancelPreview();
    closePopover();
  };
  pop.querySelector('#theme-apply').onclick = () => {
    const snapshot = themeManager.commitPreview();
    closePopover();
    toast(`已切换到${snapshot.selectedTheme === 'system' ? '跟随系统' : snapshot.theme.name}`);
  };
}

function openThemeSettings() {
  closePopover();
  state.popoverFor = 'theme-settings';
  const pop = document.createElement('div');
  pop.className = 'popover theme-settings';
  pop.style.position = 'fixed';
  pop.style.top = '70px';
  pop.style.right = '16px';
  pop.style.zIndex = 60;
  document.body.appendChild(pop);
  renderThemeSettings(pop);
}

if (themeManager) themeManager.subscribe(() => {
  const pop = document.querySelector('.theme-settings');
  if (pop && state.popoverFor === 'theme-settings') renderThemeSettings(pop);
});

function renderRoutingCreateFields(catalog) {
  const model = $('ai-routing-model');
  const status = $('ai-routing-status');
  if (!model || !status) return;
  const models = Array.isArray(catalog?.models) ? catalog.models : [];
  const selected = model.value;
  model.innerHTML = '<option value="">自动选择（不锁定）</option>' + models.map((item) => {
    const version = item.version || item.multiAgentVersion;
    const reasoning = Array.isArray(item.supportedReasoningLevels) && item.supportedReasoningLevels.length
      ? ` · ${item.supportedReasoningLevels.join('/')}` : '';
    return `<option value="${esc(item.id)}">${esc(item.displayName || item.id)}${version ? ` · ${esc(version)}` : ''}${esc(reasoning)}</option>`;
  }).join('');
  if (models.some((item) => item.id === selected)) model.value = selected;
  const renderReasoning = () => {
    const reasoning = $('ai-routing-reasoning');
    if (!reasoning) return;
    const active = models.find((item) => item.id === model.value);
    const values = active && Array.isArray(active.supportedReasoningLevels)
      ? active.supportedReasoningLevels
      : [...new Set(models.flatMap((item) => Array.isArray(item.supportedReasoningLevels) ? item.supportedReasoningLevels : []))];
    const previous = reasoning.value;
    reasoning.innerHTML = '<option value="">自动选择</option>' + values.map((value) => `<option value="${esc(value)}">${esc(value)}</option>`).join('');
    if (values.includes(previous)) reasoning.value = previous;
  };
  model.onchange = renderReasoning;
  renderReasoning();
  const supported = Array.isArray(catalog?.supportedAgents) ? catalog.supportedAgents : ['codex'];
  status.textContent = catalog
    ? (catalog.available ? `Catalog：${catalog.source}${catalog.stale ? '（stale，已标记）' : ''} · ${models.length} 个可用模型${catalog.agentVersion ? ` · Agent ${catalog.agentVersion}` : ''} · ${supported.join(' / ')}` : 'Catalog 不可用；启用路由不会阻止基础 AutoPilot。')
    : 'Catalog 尚未读取；模型与 reasoning 将按当前 Agent 能力校验。';
}

function routingAgentSupported(agent) {
  const supported = state.orchestration.routingCatalog?.supportedAgents;
  return !Array.isArray(supported) || supported.includes(agent);
}

function routingReasonLabel(reasonCode) {
  return {
    ROUTE_ESCALATED: '失败/回归后升级', ROUTE_DOWNGRADED: '成功且任务简化后降级', MANUAL_PIN: '人工锁定优先',
    ROUTE_STABLE: '沿用当前策略', ROUTING_UNAVAILABLE: '路由能力不可用', ROUTING_AGENT_UNSUPPORTED: '当前 Agent 不兼容',
    PROFILE_VERIFY_FAILED: 'Profile 验证失败', NEED_HUMAN_HIGHEST_TIER_FAILURE: '最高档仍失败，需要人工处理',
    INSUFFICIENT_HISTORY: '历史样本不足', HISTORICAL_PROFILE_RECOMMENDED: '历史 Profile 建议',
    HISTORICAL_PROFILE_STABLE: '历史 Profile 稳定', MODEL_UNAVAILABLE: '模型不可用',
  }[reasonCode] || reasonCode || '未提供原因';
}

function routingValue(value, fallback = '—') {
  return value === undefined || value === null || value === '' ? fallback : esc(value);
}

function renderRoutingCommercialOverview(pop, overview) {
  const diagnostics = overview?.diagnostics || {};
  const compatibility = diagnostics.compatibility || {};
  const catalog = diagnostics.catalog || {};
  const usage = overview?.usage || {};
  const insights = overview?.insights || {};
  const outcomes = insights.outcomes || {};
  const recommendation = insights.recommendation || {};
  const workspace = insights.workspace || {};
  const last = diagnostics.lastRoute || null;
  const receipt = overview?.receipt || null;
  const timeline = Array.isArray(overview?.auditTimeline) ? overview.auditTimeline : [];
  const catalogState = catalog.available ? `${catalog.source || 'native'}${catalog.stale ? ' · stale' : ''}` : '不可用';
  const lastRoute = last
    ? `${routingValue(last.modelId, '未应用')} · ${routingValue(last.reasoningLevel, '未验证')} · ${routingReasonLabel(last.reasonCode)}`
    : '尚无路由记录';
  const historicalProfiles = Array.isArray(outcomes.profiles) ? outcomes.profiles : [];
  const recommendationText = recommendation.profile?.modelId
    ? `${routingValue(recommendation.profile.modelId)} · ${routingValue(recommendation.profile.reasoningLevel, '未验证')} · ${routingReasonLabel(recommendation.reasonCode)}`
    : recommendation.reasonCode || '暂无足够历史数据';
  pop.innerHTML = `<div class="pop-head">AI 路由详情</div>
    <div class="routing-commerce-copy">只读（read-only）诊断视图：当前 Turn 的 Profile 快照不会被中途改写；成本和配额没有真实数据源时明确标记为不可用。</div>
    <div class="routing-commerce-grid">
      <div class="routing-commerce-metric"><span>Compatibility</span><b class="${compatibility.supported ? 'ready' : 'warning'}">${compatibility.supported ? '支持' : '不支持'}</b><small>${esc(compatibility.reasonCode || 'UNKNOWN')}</small></div>
      <div class="routing-commerce-metric"><span>Catalog Diagnostics</span><b>${esc(catalogState)}</b><small>${esc(catalog.reasonCode || '—')} · ${esc(catalog.modelCount ?? 0)} 个模型</small></div>
      <div class="routing-commerce-metric"><span>Cost / 成本</span><b>${usage.cost?.available ? '可用' : '不可用'}</b><small>${esc(usage.cost?.reasonCode || 'COST_DATA_UNAVAILABLE')}</small></div>
      <div class="routing-commerce-metric"><span>Quota / 配额</span><b>${usage.quota?.available ? '可用' : '不可用'}</b><small>${esc(usage.quota?.reasonCode || 'QUOTA_DATA_UNAVAILABLE')}</small></div>
    </div>
    <section class="routing-commerce-section"><strong>Routing Explainability</strong><div class="routing-commerce-detail">${esc(lastRoute)}</div></section>
    <section class="routing-commerce-section"><strong>Historical success rate · Worktree</strong>
      <div class="routing-commerce-detail">工作区：${workspace.safe ? '在允许范围内' : '不可验证或超出允许范围'} · ${esc(workspace.reasonCode || 'WORKSPACE_UNKNOWN')}</div>
      <div class="routing-commerce-detail">历史尝试 ${esc(outcomes.totalAttempts ?? 0)} 次，成功 ${esc(outcomes.totalSuccesses ?? 0)} 次 · 只读建议：${esc(recommendationText)}</div>
      ${historicalProfiles.length ? historicalProfiles.map((item) => `<div class="routing-audit-item"><span>${esc(item.modelId || '未命名')}</span><b>${esc(item.reasoningLevel || '未验证')}</b><span>${esc(item.successes ?? 0)}/${esc(item.attempts ?? 0)} 成功</span><em>成功率 ${esc(Math.round(Number(item.successRate || 0) * 100))}%</em></div>`).join('') : '<div class="routing-commerce-detail">暂无足够历史路由数据</div>'}
    </section>
    <section class="routing-commerce-section"><strong>Audit Timeline</strong>
      ${timeline.length ? timeline.map((item) => `<div class="routing-audit-item"><span>${esc(item.generatedAt || '未记录')}</span><b>${esc(item.event || 'routing')}</b><span>${esc(item.modelId || '未应用')} · ${esc(item.reasoningLevel || '未验证')}</span><em>${esc(routingReasonLabel(item.reasonCode))}</em></div>`).join('') : '<div class="routing-commerce-detail">暂无路由审计记录</div>'}
    </section>
    <section class="routing-commerce-section"><strong>Run Receipt</strong>
      ${receipt ? `<div class="routing-commerce-detail">${esc(receipt.finalState || 'UNKNOWN')} · DoD ${esc(receipt.dod?.passed ?? 0)}/${esc(receipt.dod?.total ?? 0)} · ${esc(receipt.stopReason || '无停止原因')}</div>` : '<div class="routing-commerce-detail">暂无 Run Receipt</div>'}
    </section>
    <div class="routing-commerce-actions"><button type="button" class="btn primary" id="routing-commerce-close">关闭</button></div>`;
  pop.querySelector('#routing-commerce-close').onclick = closePopover;
}

async function openRoutingCommercialOverview(id) {
  closePopover();
  state.popoverFor = 'routing-commercial';
  const pop = document.createElement('div');
  pop.className = 'popover routing-commerce';
  pop.style.position = 'fixed'; pop.style.top = '70px'; pop.style.right = '16px'; pop.style.zIndex = 60;
  pop.innerHTML = '<div class="pop-head">AI 路由详情</div><div class="routing-commerce-detail">正在读取 Catalog Diagnostics、Audit Timeline 和 Run Receipt…</div>';
  document.body.appendChild(pop);
  try {
    const overviewUrl = `/api/orchestration/workflows/${encodeURIComponent(id)}/routing/overview`;
    const insightsUrl = `/api/orchestration/workflows/${encodeURIComponent(id)}/routing/insights`;
    const [overview, insights] = await Promise.all([
      requestJson(overviewUrl), requestJson(insightsUrl),
    ]);
    renderRoutingCommercialOverview(pop, { ...overview, insights });
  } catch (error) {
    pop.innerHTML = `<div class="pop-head">AI 路由详情</div><div class="routing-commerce-error">读取失败：${esc(error.message || '服务暂不可用')}</div><div class="routing-commerce-actions"><button type="button" class="btn" id="routing-commerce-error-close">关闭</button></div>`;
    pop.querySelector('#routing-commerce-error-close').onclick = closePopover;
  }
}

function renderRoutingFlywheel(pop, data) {
  const totalAttempts = Number(data?.totalAttempts) || 0;
  const totalSuccesses = Number(data?.totalSuccesses) || 0;
  const agents = Array.isArray(data?.agents) ? data.agents : [];
  const taskClasses = Array.isArray(data?.taskClasses) ? data.taskClasses : [];
  const taskProfiles = Array.isArray(data?.taskProfiles) ? data.taskProfiles : [];
  const profiles = taskProfiles.length ? taskProfiles : (Array.isArray(data?.profiles) ? data.profiles : []);
  const recommendations = Array.isArray(data?.recommendations) ? data.recommendations : [];
  const taskClassLabels = { new: '新项目', existing: '现有 Git 项目', existing_unversioned: '未纳入 Git', unknown: '未知任务类型' };
  const duration = (value) => {
    const ms = Number(value);
    if (!Number.isFinite(ms)) return '—';
    if (ms < 1_000) return `${Math.round(ms)}ms`;
    if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
    return `${(ms / 60_000).toFixed(1)}min`;
  };
  const successRate = totalAttempts ? Math.round((totalSuccesses / totalAttempts) * 100) : 0;
  pop.innerHTML = `<div class="pop-head">Routing Data Flywheel</div>
    <div class="routing-commerce-copy">只读工作区汇总：按 Agent、模型和 reasoning 统计已验证的历史结果，不会自动修改任何 Workflow 的路由设置。</div>
    <div class="routing-commerce-grid">
      <div class="routing-commerce-metric"><span>历史尝试</span><b>${totalAttempts}</b><small>最近有界记录</small></div>
      <div class="routing-commerce-metric"><span>总体成功率</span><b>${successRate}%</b><small>${totalSuccesses} 次成功 · ${Number(data?.totalFailures) || 0} 次失败</small></div>
    </div>
    <section class="routing-commerce-section"><strong>任务画像</strong>
      ${taskClasses.length ? taskClasses.map((item) => `<div class="routing-audit-item"><span>${esc(item.agent || '未识别')} · ${esc(taskClassLabels[item.taskClass] || item.taskClass || '未知任务类型')}</span><b>${esc(item.successes ?? 0)}/${esc(item.attempts ?? 0)} 成功</b><span>平均耗时 ${esc(duration(item.averageDurationMs))}</span><em>DoD ${esc(Math.round(Number(item.averageDodCompletionRate || 0) * 100))}% · 人工介入 ${esc(item.humanInterventions ?? 0)} 次 · 停滞 ${esc(Number(item.averageStagnation || 0).toFixed(1))}</em></div>`).join('') : '<div class="routing-commerce-detail">暂无已完成任务画像</div>'}
    </section>
    <section class="routing-commerce-section"><strong>自动 Profile 建议（只读）</strong>
      ${recommendations.length ? recommendations.map((item) => {
        const profile = item.profile || {};
        const selected = profile.modelId ? `${profile.modelId} · ${profile.reasoningLevel || 'model-only'}` : routingReasonLabel(item.reasonCode);
        return `<div class="routing-audit-item"><span>${esc(item.agent || '未识别')} · ${esc(taskClassLabels[item.taskClass] || item.taskClass || '未知任务类型')}</span><b>${esc(selected)}</b><span>样本 ${esc(item.sampleSize ?? 0)}/${esc(item.minAttempts ?? 3)}</span><em>${esc(routingReasonLabel(item.reasonCode))}；不会自动应用</em></div>`;
      }).join('') : '<div class="routing-commerce-detail">暂无可生成的 Profile 建议</div>'}
    </section>
    <section class="routing-commerce-section"><strong>Agent 成功率</strong>
      ${agents.length ? agents.map((item) => `<div class="routing-audit-item"><span>${esc(item.agent || '未识别')}</span><b>${esc(item.successes ?? 0)}/${esc(item.attempts ?? 0)} 成功</b><span>成功率 ${esc(Math.round(Number(item.successRate || 0) * 100))}%</span></div>`).join('') : '<div class="routing-commerce-detail">暂无足够历史路由数据</div>'}
    </section>
    <section class="routing-commerce-section"><strong>Agent · Model · Reasoning</strong>
      ${profiles.length ? profiles.map((item) => `<div class="routing-audit-item"><span>${esc(item.agent || '未识别')}${item.taskClass ? ` · ${esc(taskClassLabels[item.taskClass] || item.taskClass)}` : ''} · ${esc(item.modelId || '未命名')}</span><b>${esc(item.reasoningLevel || 'model-only')}</b><span>${esc(item.successes ?? 0)}/${esc(item.attempts ?? 0)} 成功</span><em>成功率 ${esc(Math.round(Number(item.successRate || 0) * 100))}%</em></div>`).join('') : '<div class="routing-commerce-detail">暂无足够历史路由数据</div>'}
    </section>
    <div class="routing-commerce-actions"><button type="button" class="btn primary" id="routing-flywheel-close">关闭</button></div>`;
  pop.querySelector('#routing-flywheel-close').onclick = closePopover;
}

async function openRoutingFlywheel() {
  closePopover();
  state.popoverFor = 'routing-flywheel';
  const pop = document.createElement('div');
  pop.className = 'popover routing-commerce';
  pop.style.position = 'fixed'; pop.style.top = '70px'; pop.style.right = '16px'; pop.style.zIndex = 60;
  pop.innerHTML = '<div class="pop-head">Routing Data Flywheel</div><div class="routing-commerce-detail">正在读取工作区历史路由数据…</div>';
  document.body.appendChild(pop);
  try {
    const data = await requestJson('/api/orchestration/routing/insights');
    renderRoutingFlywheel(pop, data);
  } catch (error) {
    pop.innerHTML = `<div class="pop-head">Routing Data Flywheel</div><div class="routing-commerce-error">读取失败：${esc(error.message || '服务暂不可用')}</div><div class="routing-commerce-actions"><button type="button" class="btn" id="routing-flywheel-error-close">关闭</button></div>`;
    pop.querySelector('#routing-flywheel-error-close').onclick = closePopover;
  }
}

function routingConfigFromCreateForm() {
  const enabled = $('ai-routing-enabled')?.checked === true && routingAgentSupported($('ai-agent')?.value);
  const modelId = $('ai-routing-model')?.value || '';
  const reasoningLevel = $('ai-routing-reasoning')?.value || '';
  return {
    enabled,
    preset: $('ai-routing-preset')?.value || 'balanced',
    autoModel: $('ai-routing-auto-model')?.checked !== false,
    autoReasoning: $('ai-routing-auto-reasoning')?.checked !== false,
    respectManualPin: $('ai-routing-respect-pin')?.checked !== false,
    allowLegacyModels: $('ai-routing-allow-legacy')?.checked === true,
    ...(modelId || reasoningLevel ? { manualPin: { modelId: modelId || null, reasoningLevel: reasoningLevel || null } } : {}),
  };
}

function openRoutingSettings() {
  closePopover();
  state.popoverFor = 'routing-settings';
  const pop = document.createElement('div');
  pop.className = 'popover routing-settings';
  pop.style.position = 'fixed'; pop.style.top = '70px'; pop.style.right = '16px'; pop.style.zIndex = 60;
  document.body.appendChild(pop);
  const settings = state.orchestration.settings || {};
  const autopilot = settings.autopilot || {};
  const routing = settings.routing || {};
  const safety = settings.safety || {};
  const catalog = state.orchestration.routingCatalog || {};
  const models = Array.isArray(catalog.models) ? catalog.models : [];
  pop.innerHTML = `<div class="pop-head">AI 智能执行调度</div>
    <div class="routing-settings-copy">这里保存的是跨 Workflow 生效的默认设置；当前 Turn 的 Profile 快照不会被中途改写。</div>
    <form class="routing-settings-form" id="routing-settings-form">
      <label>默认模式<select id="routing-default-mode"><option value="auto"${autopilot.defaultMode === 'auto' ? ' selected' : ''}>Auto：自动循环</option><option value="suggest"${autopilot.defaultMode === 'suggest' ? ' selected' : ''}>Suggest：只生成建议</option></select></label>
      <label>最大循环轮数<input id="routing-max-iterations" type="number" min="1" max="100" value="${esc(autopilot.maxIterations ?? 20)}"></label>
      <label>最大运行时间（毫秒）<input id="routing-max-runtime" type="number" min="1000" max="86400000" value="${esc(autopilot.maxRuntimeMs ?? 3600000)}"></label>
      <label>周期复核间隔（毫秒）<input id="routing-reconcile-ms" type="number" min="1000" max="3600000" value="${esc(autopilot.reconciliationIntervalMs ?? 30000)}"></label>
      <label class="routing-checkbox"><input id="routing-enabled" type="checkbox"${routing.enabled !== false ? ' checked' : ''}>启用智能路由</label>
      <label>路由预设<select id="routing-preset"><option value="balanced"${routing.preset === 'balanced' ? ' selected' : ''}>Balanced</option><option value="quality"${routing.preset === 'quality' ? ' selected' : ''}>Quality First</option><option value="save"${routing.preset === 'save' ? ' selected' : ''}>Economy</option><option value="custom"${routing.preset === 'custom' ? ' selected' : ''}>Custom</option></select></label>
      <label class="routing-checkbox"><input id="routing-auto-model" type="checkbox"${routing.autoModel !== false ? ' checked' : ''}>自动调整模型</label>
      <label class="routing-checkbox"><input id="routing-auto-reasoning" type="checkbox"${routing.autoReasoning !== false ? ' checked' : ''}>自动调整思考强度</label>
      <label class="routing-checkbox"><input id="routing-respect-pin" type="checkbox"${routing.respectManualPin !== false ? ' checked' : ''}>尊重人工模型锁定</label>
      <label class="routing-checkbox"><input id="routing-allow-legacy" type="checkbox"${routing.allowLegacyModels === true ? ' checked' : ''}>允许使用 Legacy Models</label>
      <label>模型切换无法验证<select id="routing-profile-failure"><option value="pause"${safety.profileApplyFailure !== 'continue' ? ' selected' : ''}>暂停并等待人工</option><option value="continue"${safety.profileApplyFailure === 'continue' ? ' selected' : ''}>继续使用当前模型</option></select></label>
      <div class="routing-settings-copy">${catalog.available ? `Codex Catalog：${esc(catalog.source || 'native')}${catalog.stale ? ' · stale' : ''} · ${models.length} 个模型${catalog.agentVersion ? ` · Agent ${esc(catalog.agentVersion)}` : ''}` : 'Catalog 不可用；保存配置不会阻止基础 AutoPilot。'}</div>
      <div class="routing-settings-actions"><button type="button" class="btn" id="routing-catalog-refresh">刷新 Codex 模型</button><button type="button" class="btn" id="routing-settings-cancel">取消</button><button type="submit" class="btn primary">保存全局设置</button></div>
    </form>`;
  pop.querySelector('#routing-settings-cancel').onclick = closePopover;
  pop.querySelector('#routing-catalog-refresh').onclick = async () => {
    try {
      await requestJson('/api/orchestration/routing/catalog/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent: 'codex' }) });
      toast('Codex 模型 Catalog 已刷新'); await loadOrchestration();
    } catch (error) { toast(error.message || '模型 Catalog 刷新失败'); }
  };
  pop.querySelector('#routing-settings-form').onsubmit = async (event) => {
    event.preventDefault();
    const body = {
      autopilot: {
        defaultMode: pop.querySelector('#routing-default-mode').value,
        maxIterations: Number(pop.querySelector('#routing-max-iterations').value),
        maxRuntimeMs: Number(pop.querySelector('#routing-max-runtime').value),
        reconciliationIntervalMs: Number(pop.querySelector('#routing-reconcile-ms').value),
      },
      routing: {
        enabled: pop.querySelector('#routing-enabled').checked,
        preset: pop.querySelector('#routing-preset').value,
        autoModel: pop.querySelector('#routing-auto-model').checked,
        autoReasoning: pop.querySelector('#routing-auto-reasoning').checked,
        respectManualPin: pop.querySelector('#routing-respect-pin').checked,
        allowLegacyModels: pop.querySelector('#routing-allow-legacy').checked,
      },
      safety: { profileApplyFailure: pop.querySelector('#routing-profile-failure').value },
    };
    try {
      await requestJson('/api/orchestration/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      closePopover(); toast('AI 智能执行调度已保存，下一次托管起生效'); await loadOrchestration();
    } catch (error) { toast(error.message || '全局设置保存失败'); }
  };
}

function openProviderSettings() {
  closePopover();
  state.popoverFor = 'provider-settings';
  const pop = document.createElement('div');
  pop.className = 'popover provider-settings';
  pop.style.position = 'fixed'; pop.style.top = '70px'; pop.style.right = '16px'; pop.style.zIndex = 60;
  const provider = state.orchestration.providerConfig || {};
  const supervisor = provider.supervisor || {};
  const worker = provider.workerRouting || {};
  const line = (label, value) => `<div class="provider-settings-line"><span>${esc(label)}</span><b>${esc(value || '—')}</b></div>`;
  pop.innerHTML = `<div class="pop-head">Provider 配置状态</div>
    <div class="provider-settings-copy">此处只展示安全状态。桌面端 Provider Key 通过 Electron safeStorage 管理，不进入 workflow、日志、Audit 或浏览器持久化；详细管理请在 AI 监控面板操作。</div>
    <div class="provider-settings-section"><strong>Supervisor</strong>${line('供应商', supervisor.providerName || supervisor.provider)}${line('模型', supervisor.model)}${line('Base URL', supervisor.baseUrl)}${line('Temperature', supervisor.temperature)}${line('Context Budget', supervisor.contextBudget)}${line('状态', supervisor.reasonCode)}</div>
    <div class="provider-settings-section"><strong>Worker Routing</strong>${line('供应商', worker.providerName || worker.provider)}${line('模型', worker.model)}${line('状态', worker.reasonCode)}</div>
    <div class="routing-settings-actions"><button type="button" class="btn" id="provider-settings-close">关闭</button></div>`;
  document.body.appendChild(pop);
  pop.querySelector('#provider-settings-close').onclick = closePopover;
}

function openSettingsHub() {
  closePopover();
  state.popoverFor = 'settings';
  const pop = document.createElement('div');
  pop.className = 'popover';
  pop.style.position = 'fixed';
  pop.style.top = '70px';
  pop.style.right = '16px';
  pop.style.zIndex = 60;
  pop.style.minWidth = '200px';
  document.body.appendChild(pop);
  pop.innerHTML = `<div class="pop-head">设置</div>
    <button class="pop-item" id="settings-cols">Agent 显示设置</button>
    <button class="pop-item" id="settings-account">账户与方案</button>
    <button class="pop-item" id="settings-sound">提示音设置</button>
    <button class="pop-item" id="settings-shortcut">快捷键设置</button>
    <button class="pop-item" id="settings-theme">主题设置</button>
    <button class="pop-item" id="settings-provider">Provider 配置状态</button>
    <button class="pop-item" id="settings-autopilot-routing">AI 智能执行调度</button>
    <button class="pop-item" id="settings-routing-flywheel">历史路由数据</button>
    <button class="pop-item" id="settings-launch">模型端口设置</button>`;
  pop.querySelector('#settings-cols').onclick = openColManager;
  pop.querySelector('#settings-account').onclick = openAccountSettings;
  pop.querySelector('#settings-sound').onclick = openSoundSettings;
  pop.querySelector('#settings-shortcut').onclick = openShortcutSettings;
  pop.querySelector('#settings-theme').onclick = openThemeSettings;
  pop.querySelector('#settings-provider').onclick = openProviderSettings;
  pop.querySelector('#settings-autopilot-routing').onclick = openRoutingSettings;
  pop.querySelector('#settings-routing-flywheel').onclick = openRoutingFlywheel;
  // openLaunchOverridesManager 用箭头函数包一层再引用，而不是直接把裸标识符赋给 onclick——
  // 直接赋值在这一行执行的瞬间就会去解析这个标识符，Task 6 之前它还没定义，会立刻抛
  // ReferenceError（不是等真正点击才抛）；包一层可以把这个解析推迟到真正点击的那一刻。
  pop.querySelector('#settings-launch').onclick = () => openLaunchOverridesManager();
}

function desktopCloudApi() {
  const cloud = window.AgentBoardDesktop?.cloud;
  return cloud && typeof cloud.getStatus === 'function' ? cloud : null;
}

function authErrorMessage(error, fallback = '操作失败') {
  const code = error?.code || '';
  const messages = {
    AUTH_INVALID_CREDENTIALS: '邮箱或密码不正确',
    USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: '该邮箱已注册，请直接登录',
    INVALID_REDEMPTION_CODE: '激活码无效',
    REDEMPTION_ALREADY_USED: '激活码已经使用过了',
    REDEMPTION_EXPIRED: '激活码已过期',
    REDEMPTION_REVOKED: '激活码已失效',
    PLAN_DISABLED: '激活码对应的方案已停用',
    PRODUCT_DISABLED: '激活码对应的产品已停用',
    INVALID_USER_EMAIL: '请输入有效的邮箱地址',
    INVALID_USER_PASSWORD: '密码至少需要 8 位',
    CLOUD_NETWORK_UNAVAILABLE: '暂时无法连接云端，请检查网络后重试',
    REGISTRATION_UNAVAILABLE: '注册服务暂不可用，请稍后重试',
  };
  return messages[code] || error?.message || fallback;
}

function renderDesktopAuthGate(gate, cloud, initialMessage = '') {
  gate.innerHTML = `<div class="desktop-auth-shell">
    <div class="desktop-auth-brand">
      <div class="logo"><svg width="19" height="19" viewBox="0 0 24 24" fill="none"><path d="M4 5h16v14H4z" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/><path d="M8 9h8M8 13h8M8 17h5" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/></svg></div>
      <div><strong>Agent Board</strong><small>登录后开始使用</small></div>
    </div>
    <div class="desktop-auth-tabs" role="tablist">
      <button class="desktop-auth-tab active" type="button" data-auth-view="login">登录</button>
      <button class="desktop-auth-tab" type="button" data-auth-view="register">注册</button>
    </div>
    <form class="desktop-auth-form" id="desktop-auth-login">
      <label>邮箱<input name="email" type="email" autocomplete="username" required placeholder="name@example.com"></label>
      <label>密码<input name="password" type="password" autocomplete="current-password" required placeholder="请输入密码"></label>
      <button class="btn primary desktop-auth-submit" type="submit">登录并进入 Agent Board</button>
      <button class="btn" id="desktop-auth-forgot" type="button">忘记密码</button>
    </form>
    <form class="desktop-auth-form" id="desktop-auth-register" hidden>
      <label>邮箱<input name="email" type="email" autocomplete="email" required placeholder="name@example.com"></label>
      <label>密码<input name="password" type="password" autocomplete="new-password" minlength="8" required placeholder="至少 8 位"></label>
      <label>确认密码<input name="passwordConfirm" type="password" autocomplete="new-password" minlength="8" required placeholder="再次输入密码"></label>
      <label>激活码<input name="activationCode" autocomplete="off" required placeholder="请输入有效激活码"></label>
      <button class="btn primary desktop-auth-submit" type="submit">验证激活码并注册</button>
    </form>
    <div class="desktop-auth-error" role="alert">${esc(initialMessage)}</div>
    <div class="desktop-auth-help">注册必须填写激活码。激活码验证通过后才会创建账号。</div>
  </div>`;
  gate.hidden = false;
  const errorNode = gate.querySelector('.desktop-auth-error');
  const loginForm = gate.querySelector('#desktop-auth-login');
  const registerForm = gate.querySelector('#desktop-auth-register');
  const tabs = [...gate.querySelectorAll('.desktop-auth-tab')];
  const setError = (message) => { errorNode.textContent = message || ''; };
  const setBusy = (form, busy) => {
    form.querySelectorAll('input,button').forEach((node) => { node.disabled = busy; });
  };
  const switchView = (view) => {
    const register = view === 'register';
    loginForm.hidden = register;
    registerForm.hidden = !register;
    tabs.forEach((tab) => tab.classList.toggle('active', tab.dataset.authView === view));
    setError('');
  };
  tabs.forEach((tab) => { tab.onclick = () => switchView(tab.dataset.authView); });

  const complete = () => {
    if (typeof gate._authDone === 'function') gate._authDone();
  };
  loginForm.onsubmit = async (event) => {
    event.preventDefault();
    setError('');
    setBusy(loginForm, true);
    try {
      const result = await cloud.login(loginForm.elements.email.value, loginForm.elements.password.value);
      if (result?.ok === false) throw result;
      complete();
    } catch (error) {
      setError(authErrorMessage(error, '登录失败，请检查账号信息'));
      setBusy(loginForm, false);
    }
  };
  registerForm.onsubmit = async (event) => {
    event.preventDefault();
    setError('');
    if (registerForm.elements.password.value !== registerForm.elements.passwordConfirm.value) {
      setError('两次输入的密码不一致');
      return;
    }
    setBusy(registerForm, true);
    try {
      if (typeof cloud.register !== 'function') throw { code: 'REGISTRATION_UNAVAILABLE' };
      const result = await cloud.register(
        registerForm.elements.email.value,
        registerForm.elements.password.value,
        registerForm.elements.activationCode.value,
      );
      if (result?.ok === false) throw result;
      complete();
    } catch (error) {
      setError(authErrorMessage(error, '注册失败，请检查激活码和账号信息'));
      setBusy(registerForm, false);
    }
  };
  const forgotButton = gate.querySelector('#desktop-auth-forgot');
  if (forgotButton && typeof cloud.requestPasswordReset === 'function') {
    forgotButton.onclick = async () => {
      const email = loginForm.elements.email.value.trim();
      if (!email) { setError('请先填写邮箱'); return; }
      forgotButton.disabled = true;
      setError('正在发送重置邮件…');
      try {
        await cloud.requestPasswordReset(email);
        setError('如果邮箱已注册，重置链接将发送到你的邮箱。');
      } catch (error) {
        setError(authErrorMessage(error, '发送失败，请稍后重试'));
      } finally {
        forgotButton.disabled = false;
      }
    };
  } else if (forgotButton) {
    forgotButton.remove();
  }
}

async function showDesktopAuthenticationGate(cloud, message) {
  const gate = $('desktop-auth-gate');
  if (!gate) return false;
  await new Promise((resolve) => {
    gate._authDone = resolve;
    renderDesktopAuthGate(gate, cloud, message);
  });
  gate._authDone = null;
  gate.hidden = true;
  gate.innerHTML = '';
  return true;
}

async function ensureDesktopAuthentication() {
  const cloud = desktopCloudApi();
  if (!cloud) return true;
  let status;
  try {
    status = await cloud.getStatus();
  } catch (error) {
    status = { configured: true, authenticated: false, errorMessage: authErrorMessage(error, '云端状态读取失败') };
  }
  if (!status?.configured || status.authenticated) return true;
  await showDesktopAuthenticationGate(cloud, status.errorMessage || '请登录或注册后继续使用');
  return true;
}

async function logoutFromBoard() {
  const cloud = desktopCloudApi();
  const button = $('btn-logout');
  if (!cloud) {
    toast('当前运行环境未配置登录服务');
    return;
  }
  if (button) button.disabled = true;
  let logoutError = null;
  try {
    const result = await cloud.logout();
    if (result?.ok === false) throw result;
  } catch (error) {
    // cloud.logout 会在 finally 中清理本地令牌；即使云端同步失败，也必须回到登录界面。
    logoutError = error;
  }
  closePopover();
  const shown = await showDesktopAuthenticationGate(cloud, '已退出登录，请重新登录');
  if (logoutError) toast(`已清除本地登录状态，但云端同步失败：${authErrorMessage(logoutError, '请稍后重试')}`);
  else if (!shown) toast('退出成功，但登录界面不可用');
  if (button) button.disabled = false;
}

async function requestLocalAccount(path, options) {
  const api = typeof requestJson === 'function'
    ? requestJson
    : async (url, options) => {
      const response = await fetch(url, options);
      const status = await response.json();
      if (!response.ok || status.error) throw new Error(status.error || ('HTTP ' + response.status));
      return status;
    };
  return api(path, options);
}

async function fetchLocalAccountStatus() {
  return requestLocalAccount('/api/account/status');
}

function renderAccountSettings(pop, status) {
  const head = '<div class="pop-head">账户与方案</div>';
  const bodyStyle = 'padding:14px 16px;color:var(--text2);font-size:13px;line-height:1.65';
  let body = '';

  if (status.state === 'unconfigured') {
    body = `<div style="${bodyStyle}">账号云服务尚未配置，本地单机功能可继续免费使用。</div>`;
  } else if (status.state === 'active') {
    const account = status.account || {};
    const expiresAt = Number(account.expiresAt);
    const expiry = Number.isFinite(expiresAt) ? new Date(expiresAt).toLocaleString('zh-CN') : '未知';
    const features = Array.isArray(status.features) && status.features.length
      ? status.features.map((feature) => `<li>${esc(feature)}</li>`).join('')
      : '<li>暂无额外权益</li>';
    body = `<div style="${bodyStyle}">
      <div>当前方案：<strong>${esc(account.plan || '未知')}</strong></div>
      <div>到期时间：${esc(expiry)}</div>
      <div style="margin-top:6px">权益：</div><ul style="margin:2px 0 10px;padding-left:20px">${features}</ul>
      <button class="btn" id="account-logout" style="min-height:32px;padding:5px 10px;font-size:12px">退出登录</button>
    </div>`;
  } else {
    const action = status.hasCachedToken
      ? '<button class="btn" id="account-logout" style="min-height:32px;padding:5px 10px;font-size:12px">清除本地登录缓存</button>'
      : '';
    body = `<div style="${bodyStyle}"><div>当前为免费方案，本地单机功能可继续免费使用。</div><div style="margin-top:10px">${action}</div></div>`;
  }

  pop.innerHTML = head + body;
  const logoutButton = pop.querySelector('#account-logout');
  if (!logoutButton) return;
  logoutButton.onclick = async () => {
    logoutButton.disabled = true;
    try {
      const api = typeof requestJson === 'function'
        ? requestJson
        : async (url, options) => {
          const response = await fetch(url, options);
          const next = await response.json();
          if (!response.ok || next.error) throw new Error(next.error || ('HTTP ' + response.status));
          return next;
        };
      const next = await api('/api/account/logout', { method: 'POST' });
      renderAccountSettings(pop, next);
      toast('已清除本地登录缓存');
    } catch (error) {
      logoutButton.disabled = false;
      toast('操作失败：' + (error.message || '未知错误'));
    }
  };
}

async function openAccountSettings() {
  closePopover();
  state.popoverFor = 'account';
  const pop = document.createElement('div');
  pop.className = 'popover';
  pop.style.position = 'fixed';
  pop.style.top = '70px';
  pop.style.right = '16px';
  pop.style.zIndex = 60;
  pop.style.minWidth = '320px';
  document.body.appendChild(pop);
  pop.innerHTML = '<div class="pop-head">账户与方案</div><div style="padding:16px;color:var(--text3);font-size:13px">加载中…</div>';

  try {
    const api = typeof requestJson === 'function'
      ? requestJson
      : async (url, options) => {
        const response = await fetch(url, options);
        const status = await response.json();
        if (!response.ok || status.error) throw new Error(status.error || ('HTTP ' + response.status));
        return status;
      };
    const status = await api('/api/account/status');
    renderAccountSettings(pop, status);
  } catch (error) {
    pop.innerHTML = `<div class="pop-head">账户与方案</div><div style="padding:16px;color:var(--text3);font-size:13px">加载失败：${esc(error.message || '请求失败')}</div>`;
  }
}

function soundAgents() {
  return Object.entries(state.agentsDef || {});
}

function sessionRoleForRef(ref) {
  const knownRole = state.sessionRoles.get(ref);
  if (knownRole === 'child') return 'child';
  if (knownRole === 'main') return 'main';
  // Synthetic Marvis/Hermes child refs carry an explicit marker even if the
  // card was refreshed out of the current board before the completion event.
  return String(ref || '').includes(':subagent:') ? 'child' : 'main';
}

function isSoundRoleEnabled(settings, agent, role) {
  const current = settings || {};
  if ((current.disabledAgents || []).includes(agent)) return false;
  return !(current.disabledAgentRoles || []).includes(`${agent}:${role}`);
}

async function saveSoundEnabled(agents, enabled, role = 'all') {
  return requestJson('/api/sounds/enabled', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agents, enabled, role }),
  });
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('读取音频文件失败'));
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(file);
  });
}

const soundAudioCache = new Map();

function getPreloadedSound(url) {
  if (typeof url !== 'string' || !url) return null;
  const cached = soundAudioCache.get(url);
  if (cached) return cached;

  const audio = new Audio();
  audio.preload = 'auto';
  audio.src = url;
  audio.load();
  soundAudioCache.set(url, audio);
  return audio;
}

function preloadAssignedSounds(settings) {
  const soundsById = new Map((settings?.sounds || []).map((sound) => [sound.id, sound]));
  for (const soundId of Object.values(settings?.assignments || {})) {
    const sound = soundsById.get(soundId);
    if (sound?.url) getPreloadedSound(sound.url);
  }
}

function playSoundPreview(url) {
  const audio = getPreloadedSound(url);
  if (!audio) return;
  audio.pause();
  try { audio.currentTime = 0; } catch {}
  audio.play().catch(() => toast('浏览器阻止了播放，请再次点击试听'));
}

function renderSoundSettings(pop, selectedAgent) {
  const settings = state.completionSounds || { assignments: {}, sounds: [], disabledAgents: [], disabledAgentRoles: [] };
  const agents = soundAgents();
  if (!agents.some(([id]) => id === selectedAgent)) selectedAgent = agents[0]?.[0] || '';
  const selectedMeta = state.agentsDef[selectedAgent] || { color: '#888', name: selectedAgent };
  const selectedSoundId = settings.assignments[selectedAgent] || '';
  const childEnabled = selectedAgent ? isSoundRoleEnabled(settings, selectedAgent, 'child') : false;
  const allChildEnabled = agents.length > 0 && agents.every(([id]) => isSoundRoleEnabled(settings, id, 'child'));
  const agentList = agents.map(([id, meta]) => {
    const name = meta.name || id;
    const enabled = isSoundRoleEnabled(settings, id, 'child');
    return `<div class="sound-agent-row ${id === selectedAgent ? 'on' : ''}">
      <button type="button" class="sound-agent" data-agent="${esc(id)}" aria-current="${id === selectedAgent ? 'true' : 'false'}">
        <span class="dot" style="background:${esc(meta.color || '#888')}"></span><span class="sound-agent-name">${esc(name)}</span>
      </button>
      <button type="button" class="sound-toggle ${enabled ? 'on' : ''}" data-agent-toggle="${esc(id)}" role="switch" aria-checked="${enabled ? 'true' : 'false'}" aria-label="${esc(name)}子代理完成通知开关" title="${enabled ? '关闭' : '开启'} ${esc(name)}子代理完成通知">
        <span class="sound-toggle-track"><span class="sound-toggle-thumb"></span></span>
      </button>
    </div>`;
  }).join('');
  const soundRows = settings.sounds.map((sound) => `<div style="display:flex;align-items:center;gap:8px;padding:8px;border:1px solid var(--border);border-radius:7px;margin-top:7px">
      <span class="sound-name" title="${esc(sound.name)}">${esc(sound.name)}${sound.id === selectedSoundId ? ' · 当前使用' : ''}</span>
      <button class="btn sound-preview" data-url="${esc(sound.url)}" style="min-height:28px;padding:3px 8px;font-size:12px">试听</button>
      <button class="btn sound-delete" data-sound-id="${esc(sound.id)}" data-sound-name="${esc(sound.name)}" style="min-height:28px;padding:3px 8px;font-size:12px;color:#B91C1C">删除</button></div>`).join('');
  const selectedSound = settings.sounds.find((sound) => sound.id === selectedSoundId);
  const soundOptions = [`<option value="">不播放提示音</option>`, ...settings.sounds.map((sound) => `<option value="${esc(sound.id)}" ${sound.id === selectedSoundId ? 'selected' : ''}>${esc(sound.name)}</option>`)].join('');
  pop.innerHTML = `<div class="pop-head sound-settings-head"><span>完成提示音设置 <span style="opacity:.55;font-weight:400">（主任务与子代理共用当前提示音）</span></span>
      <div class="sound-global-actions"><span class="sound-global-state">子代理通知：${allChildEnabled ? '全部开启' : '部分开启或已关闭'}</span><button type="button" class="btn sound-toggle-all" id="sound-toggle-subagent-all-on" title="开启所有 Agent 的子代理完成通知">全部开启</button><button type="button" class="btn sound-toggle-all" id="sound-toggle-subagent-all-off" title="关闭所有 Agent 的子代理完成通知">全部关闭</button></div></div>
    <div style="display:grid;grid-template-columns:190px minmax(360px,1fr);max-height:68vh">
      <aside class="sound-agent-list" style="padding:8px;border-right:1px solid var(--border);overflow-y:auto"><div class="sound-agent-list-title">各 Agent 子代理通知</div>${agentList || '<div style="padding:8px;color:var(--text3);font-size:13px">暂无可配置 Agent</div>'}</aside>
      <section class="sound-settings-panel" style="padding:14px;overflow-y:auto"><div class="sound-selected-agent" style="font-weight:600;color:var(--text)"><span class="dot" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${esc(selectedMeta.color || '#888')};margin-right:6px"></span>${esc(selectedMeta.name || selectedAgent)}</div>
        <div class="sound-subagent-box"><div class="sound-subagent-copy"><strong>子代理任务完成通知</strong><small>仅控制 ${esc(selectedMeta.name || selectedAgent)} 的子代理会话完成时是否播放，主任务提示音不受影响。</small></div><button type="button" class="sound-toggle ${childEnabled ? 'on' : ''}" id="sound-subagent-toggle" role="switch" aria-checked="${childEnabled ? 'true' : 'false'}" aria-label="${esc(selectedMeta.name || selectedAgent)}子代理完成通知开关" title="${childEnabled ? '关闭' : '开启'}子代理完成通知"><span class="sound-toggle-track"><span class="sound-toggle-thumb"></span></span></button></div>
        <div class="sound-audio-box"><div class="sound-audio-label">当前提示音（主任务与子代理共用）</div><div class="sound-select-row"><select id="completion-sound-select" class="sound-select" ${selectedAgent ? '' : 'disabled'}>${soundOptions}</select><button type="button" class="btn sound-preview-current" data-url="${esc(selectedSound?.url || '')}" ${selectedSound ? '' : 'disabled'}>试听</button></div><div class="sound-audio-help">主任务和子代理使用同一个 Agent 提示音；下拉框选“不播放提示音”即可关闭该 Agent 的声音。</div></div>
        ${soundRows ? `<div class="sound-library-label">声音库管理</div><div class="sound-library">${soundRows}</div>` : '<div class="sound-empty">还没有提示音，请上传一个本地音频。</div>'}
        <div class="sound-upload-row"><label class="btn" style="display:inline-flex;align-items:center;min-height:32px;padding:5px 10px;font-size:12px;cursor:pointer">上传本地音频<input id="sound-upload" type="file" accept="audio/wav,audio/mpeg,audio/ogg,audio/mp4,audio/aac,.wav,.mp3,.ogg,.m4a,.aac" hidden></label><span>WAV / MP3 / OGG / M4A / AAC，最多 8 MB</span></div>
      </section>
    </div>`;
  pop.querySelectorAll('.sound-agent').forEach((button) => { button.onclick = (event) => { event.stopPropagation(); renderSoundSettings(pop, button.dataset.agent); }; });
  const applyEnabled = async (agentIds, enabled, message, role = 'all') => {
    try {
      state.completionSounds = await saveSoundEnabled(agentIds, enabled, role);
      renderSoundSettings(pop, selectedAgent);
      toast(message);
    } catch (error) {
      toast('保存失败：' + (error.message || '未知错误'));
      renderSoundSettings(pop, selectedAgent);
    }
  };
  pop.querySelectorAll('[data-agent-toggle]').forEach((button) => {
    button.onclick = async (event) => {
      event.stopPropagation();
      button.disabled = true;
      const agent = button.dataset.agentToggle;
      const enabled = button.getAttribute('aria-checked') !== 'true';
      await applyEnabled([agent], enabled, enabled ? '已开启该 Agent 子代理完成通知' : '已关闭该 Agent 子代理完成通知', 'child');
    };
  });
  const selectedToggle = pop.querySelector('#sound-subagent-toggle');
  if (selectedToggle) selectedToggle.onclick = async (event) => {
    event.stopPropagation();
    selectedToggle.disabled = true;
    await applyEnabled([selectedAgent], !childEnabled, !childEnabled ? '已开启该 Agent 子代理完成通知' : '已关闭该 Agent 子代理完成通知', 'child');
  };
  const allOnButton = pop.querySelector('#sound-toggle-subagent-all-on');
  if (allOnButton) allOnButton.onclick = async (event) => {
    event.stopPropagation();
    allOnButton.disabled = true;
    await applyEnabled(agents.map(([id]) => id), true, '已开启全部 Agent 子代理完成通知', 'child');
  };
  const allOffButton = pop.querySelector('#sound-toggle-subagent-all-off');
  if (allOffButton) allOffButton.onclick = async (event) => {
    event.stopPropagation();
    allOffButton.disabled = true;
    await applyEnabled(agents.map(([id]) => id), false, '已关闭全部 Agent 子代理完成通知', 'child');
  };
  const soundSelect = pop.querySelector('#completion-sound-select');
  if (soundSelect) soundSelect.onchange = async (event) => {
    event.stopPropagation();
    try {
      const next = await requestJson('/api/sounds/assign', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent: selectedAgent, soundId: soundSelect.value }) });
      state.completionSounds = next;
      preloadAssignedSounds(state.completionSounds);
      renderSoundSettings(pop, selectedAgent);
      toast(soundSelect.value ? '已设置当前提示音' : '已关闭该 Agent 提示音');
    } catch (error) { toast('保存失败：' + (error.message || '未知错误')); renderSoundSettings(pop, selectedAgent); }
  };
  const currentPreview = pop.querySelector('.sound-preview-current');
  if (currentPreview) currentPreview.onclick = (event) => { event.stopPropagation(); if (currentPreview.dataset.url) playSoundPreview(currentPreview.dataset.url); };
  pop.querySelectorAll('.sound-preview').forEach((button) => { button.onclick = (event) => { event.stopPropagation(); playSoundPreview(button.dataset.url); }; });
  pop.querySelectorAll('.sound-delete').forEach((button) => {
    button.onclick = async (event) => {
      event.stopPropagation();
      if (!confirm(`确定要删除提示音“${button.dataset.soundName}”吗？删除后无法恢复。`)) return;
      button.disabled = true;
      const soundId = button.dataset.soundId;
      try {
        const response = await fetch('/api/sounds/' + encodeURIComponent(soundId), { method: 'DELETE' });
        const next = await readApiResponse(response);
        if (next) {
          state.completionSounds = next;
          preloadAssignedSounds(state.completionSounds);
        }
        else await loadCompletionSounds();
        renderSoundSettings(pop, selectedAgent);
        toast('提示音已删除');
      } catch (error) {
        button.disabled = false;
        toast('删除失败：' + (error.message || '未知错误'));
      }
    };
  });
  const uploadInput = pop.querySelector('#sound-upload');
  if (uploadInput) uploadInput.onchange = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) { toast('音频不能超过 8 MB'); return; }
    try {
      const dataUrl = await readFileAsDataUrl(file);
      const result = await requestJson('/api/sounds/upload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dataUrl, name: file.name }) });
      state.completionSounds = result.settings;
      preloadAssignedSounds(state.completionSounds);
      renderSoundSettings(pop, selectedAgent);
      toast('提示音已上传到项目');
    } catch (error) { toast('上传失败：' + (error.message || '未知错误')); }
  };
}

async function loadCompletionSounds() {
  try {
    state.completionSounds = await requestJson('/api/sounds');
    preloadAssignedSounds(state.completionSounds);
  } catch { state.completionSounds = { assignments: {}, sounds: [], disabledAgents: [], disabledAgentRoles: [] }; }
}

async function openSoundSettings() {
  closePopover();
  state.popoverFor = 'sounds';
  const pop = document.createElement('div');
  pop.className = 'popover';
  pop.style.position = 'fixed'; pop.style.top = '70px'; pop.style.right = '16px'; pop.style.zIndex = 60;
  pop.style.width = '760px'; pop.style.maxWidth = 'calc(100vw - 32px)';
  document.body.appendChild(pop);
  pop.innerHTML = '<div class="pop-head">完成提示音设置</div><div style="padding:16px;color:var(--text3);font-size:13px">加载中…</div>';
  await loadCompletionSounds();
  renderSoundSettings(pop, soundAgents()[0]?.[0]);
}

const DEFAULT_AGENT_BOARD_SHORTCUT = 'Alt+`';
const DEFAULT_AGENT_BOARD_JUMP_SHORTCUT = 'Alt+1';
const SHORTCUT_SETTING_DEFS = [
  {
    kind: 'activateApp', inputId: 'shortcut-input', recordId: 'shortcut-record',
    resetId: 'shortcut-reset', saveId: 'shortcut-save', statusId: 'shortcut-status',
    title: '激活 Agent Board 到前台', help: '在任意应用中按下该组合键，可显示并聚焦 Agent Board 窗口。',
    ariaLabel: 'Agent Board 激活快捷键', defaultValue: DEFAULT_AGENT_BOARD_SHORTCUT,
  },
  {
    kind: 'jumpToLatestCompleted', inputId: 'jump-shortcut-input', recordId: 'jump-shortcut-record',
    resetId: 'jump-shortcut-reset', saveId: 'jump-shortcut-save', statusId: 'jump-shortcut-status',
    title: '跳转到最近完成任务', help: '在任意应用中按下该组合键，可打开最新完成且未读的 Agent 任务。',
    ariaLabel: '最近完成任务跳转快捷键', defaultValue: DEFAULT_AGENT_BOARD_JUMP_SHORTCUT,
  },
];

function renderShortcutSettings(pop, settings, bridge) {
  const unavailable = !bridge;
  pop.innerHTML = `<div class="pop-head">快捷键设置</div>${SHORTCUT_SETTING_DEFS.map((def) => {
    const current = settings?.[def.kind] || (def.kind === 'activateApp' ? settings?.shortcut : '') || def.defaultValue;
    const active = settings?.[def.kind === 'activateApp' ? 'activeShortcut' : 'activeJumpToLatestCompleted'];
    return `<div class="shortcut-settings" data-shortcut-kind="${def.kind}">
      <div class="shortcut-title">${def.title}</div>
      <div class="shortcut-help">${def.help}</div>
      <div class="shortcut-row">
        <input id="${def.inputId}" class="shortcut-input" value="${esc(current)}" readonly aria-label="${def.ariaLabel}" ${unavailable ? 'disabled' : ''}>
        <button class="btn" id="${def.recordId}" type="button" ${unavailable ? 'disabled' : ''}>录入快捷键</button>
      </div>
      <div class="shortcut-status" id="${def.statusId}">${unavailable ? '快捷键仅在桌面版中可用。' : active === current ? '当前快捷键已启用。' : '当前快捷键尚未成功注册，请重新录入。'}</div>
      <div class="shortcut-actions">
        <button class="btn" id="${def.resetId}" type="button" ${unavailable ? 'disabled' : ''}>恢复默认（${esc(def.defaultValue)}）</button>
        <button class="btn primary" id="${def.saveId}" type="button" ${unavailable ? 'disabled' : ''}>保存快捷键</button>
      </div>
    </div>`;
  }).join('')}`;
  if (unavailable) return;

  for (const def of SHORTCUT_SETTING_DEFS) {
    const input = pop.querySelector('#' + def.inputId);
    const recordButton = pop.querySelector('#' + def.recordId);
    const resetButton = pop.querySelector('#' + def.resetId);
    const saveButton = pop.querySelector('#' + def.saveId);
    const status = pop.querySelector('#' + def.statusId);
    let recording = false;
    let candidate = input.value;

    const setStatus = (message, error = false) => {
      status.textContent = message;
      status.classList.toggle('error', error);
    };
    const persist = async (shortcut, successMessage) => {
      saveButton.disabled = true;
      resetButton.disabled = true;
      try {
        const result = await bridge.setShortcutSettings(shortcut, def.kind);
        if (!result?.ok) {
          setStatus(result?.error || '快捷键保存失败。', true);
          return;
        }
        candidate = result[def.kind] || shortcut;
        input.value = candidate;
        setStatus(successMessage || '快捷键已保存。');
        toast('快捷键设置已保存');
      } catch (error) {
        setStatus(error.message || '快捷键保存失败。', true);
      } finally {
        saveButton.disabled = false;
        resetButton.disabled = false;
      }
    };

    recordButton.onclick = (event) => {
      event.stopPropagation();
      recording = true;
      input.focus();
      setStatus('请按下包含 Alt、Ctrl、Shift 或 Win 的组合键…');
    };
    input.onkeydown = (event) => {
      if (!recording) return;
      event.preventDefault();
      event.stopPropagation();
      const next = window.AgentBoardShortcutUtils.acceleratorFromKeyboardEvent(event);
      if (!next) {
        setStatus('请至少包含一个修饰键和一个普通按键。', true);
        return;
      }
      recording = false;
      candidate = next;
      input.value = next;
      setStatus('快捷键已录入，点击“保存快捷键”后生效。');
    };
    saveButton.onclick = (event) => {
      event.stopPropagation();
      persist(candidate);
    };
    resetButton.onclick = (event) => {
      event.stopPropagation();
      persist(def.defaultValue, `已恢复并启用默认快捷键 ${def.defaultValue}。`);
    };
  }
}

async function openShortcutSettings() {
  closePopover();
  state.popoverFor = 'shortcuts';
  const pop = document.createElement('div');
  pop.className = 'popover';
  pop.style.position = 'fixed'; pop.style.top = '70px'; pop.style.right = '16px'; pop.style.zIndex = 60;
  pop.style.width = '500px'; pop.style.maxWidth = 'calc(100vw - 32px)';
  document.body.appendChild(pop);
  const bridge = window.AgentBoardDesktop;
  pop.innerHTML = '<div class="pop-head">快捷键设置</div><div style="padding:16px;color:var(--text3);font-size:13px">加载中…</div>';
  if (!bridge) {
    renderShortcutSettings(pop, null, null);
    return;
  }
  try {
    const settings = await bridge.getShortcutSettings();
    renderShortcutSettings(pop, settings, bridge);
  } catch (error) {
    renderShortcutSettings(pop, { shortcut: DEFAULT_AGENT_BOARD_SHORTCUT }, null);
    const status = pop.querySelector('#shortcut-status');
    if (status) { status.textContent = `加载失败：${error.message || '无法读取快捷键设置'}`; status.classList.add('error'); }
  }
}

// 每个 agent 默认
function launchTargetText(target, info) {
  if (!info || info.available !== true) return target === 'cli' ? '未找到 CLI' : '未找到桌面端';
  return info.kind === 'path' && info.value ? info.value : (info.detail || '已找到');
}

function updateLaunchRowState(row) {
  const manualEnabled = row.querySelector('.lo-manual-enabled').checked;
  row.querySelectorAll('.lo-auto-btn').forEach((button) => {
    button.disabled = manualEnabled || button.dataset.available !== '1';
  });
  const manualTarget = row.querySelector('.lo-input').value.trim();
  const saveButton = row.querySelector('.lo-manual-save');
  saveButton.disabled = !manualEnabled || !manualTarget;
  row.classList.toggle('manual-on', manualEnabled);
}

async function saveLaunchOverrideSetting(agent, enabled, target) {
  return requestJson('/api/launch-overrides', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent, enabled, target }),
  });
}

/* ---------- 模型端口设置（自动识别 + 手动指定桌面端） ---------- */
async function openLaunchOverridesManager() {
  closePopover();
  state.popoverFor = 'launch-overrides';
  const pop = document.createElement('div');
  pop.className = 'popover';
  pop.style.position = 'fixed';
  pop.style.top = '70px';
  pop.style.right = '16px';
  pop.style.zIndex = 60;
  pop.style.width = '560px';
  pop.style.maxWidth = 'calc(100vw - 24px)';
  document.body.appendChild(pop);
  pop.innerHTML = '<div class="pop-head">模型端口设置</div><div style="padding:16px;color:var(--text3);font-size:13px">加载中…</div>';

  let targets;
  try {
    const r = await fetch('/api/launch-targets');
    const d = await readJsonResponse(r);
    if (!r.ok || d.error) throw new Error(d.error || ('HTTP ' + r.status));
    targets = d.targets || {};
  } catch (e) {
    // 拿不到真实数据就明确报错，不渲染空表，避免用户误以为自动目标都不存在。
    const detail = e && e.message ? `（${esc(e.message)}）` : '';
    pop.innerHTML = `<div class="pop-head">模型端口设置</div><div style="padding:16px;color:var(--text3);font-size:13px">自动识别失败${detail}</div>`;
    return;
  }

  const defs = state.agentsDef || {};
  let html = `<div class="pop-head">模型端口设置 <span style="opacity:.5;font-weight:400">（自动识别 CLI/Desktop；手动路径只用于启动桌面端）</span></div>
    <div class="lo-list">`;
  for (const id of Object.keys(defs)) {
    const meta = defs[id];
    const item = targets[id] || {};
    const cli = item.cli || {};
    const desktop = item.desktop || {};
    const manual = item.manualDesktop || { enabled: false, target: '' };
    const availableCount = [cli, desktop].filter((target) => target.available === true).length;
    const status = availableCount === 2 ? '已找到 CLI 和桌面端'
      : availableCount === 1 ? '当前只找到一种启动方式' : '暂未找到自动启动方式';
    const icon = meta.icon
      ? `<img src="/icons/${esc(meta.icon)}" alt="" class="lo-agent-icon">`
      : `<span class="lo-agent-dot" style="background:${esc(meta.color || '#888')}"></span>`;
    html += `<section class="lo-agent-row" data-id="${esc(id)}">
      <div class="lo-agent-head">${icon}<div><div class="lo-agent-name">${esc(meta.name || id)}</div><div class="lo-status">${esc(status)}</div></div></div>
      <div class="lo-auto-grid">
        <div class="lo-auto-item"><button class="btn primary lo-auto-btn" data-target="cli" data-available="${cli.available === true ? '1' : '0'}">${cli.available === true ? '切换到 CLI' : 'CLI 未找到'}</button><div class="lo-target-detail">${esc(launchTargetText('cli', cli))}</div></div>
        <div class="lo-auto-item"><button class="btn primary lo-auto-btn" data-target="desktop" data-available="${desktop.available === true ? '1' : '0'}">${desktop.available === true ? '切换到桌面端' : '桌面端未找到'}</button><div class="lo-target-detail">${esc(launchTargetText('desktop', desktop))}</div></div>
      </div>
      <div class="lo-manual-block">
        <label class="lo-manual-label"><input type="checkbox" class="lo-manual-enabled" ${manual.enabled === true ? 'checked' : ''}>手动指定桌面端</label>
        <input class="lo-input" type="text" placeholder="例如：C:\\Users\\Administrator\\AppData\\Local\\Programs\\DSH Desktop\\DSH Desktop.exe" value="${esc(manual.target || '')}">
        <div class="lo-help">也可以填写 .cmd/.bat 或命令行；勾选后优先于上面的自动方式</div>
        <button class="btn primary lo-manual-save">保存并切换到桌面端</button>
      </div>
    </section>`;
  }
  html += '</div>';
  pop.innerHTML = html;

  pop.querySelectorAll('.lo-agent-row').forEach((row) => {
    const id = row.dataset.id;
    const checkbox = row.querySelector('.lo-manual-enabled');
    const input = row.querySelector('.lo-input');
    const manualSave = row.querySelector('.lo-manual-save');
    const autoButtons = row.querySelectorAll('.lo-auto-btn');
    updateLaunchRowState(row);
    input.addEventListener('input', () => updateLaunchRowState(row));
    checkbox.addEventListener('change', async () => {
      const enabled = checkbox.checked;
      const target = input.value.trim();
      checkbox.disabled = true;
      try {
        await saveLaunchOverrideSetting(id, enabled, target);
        toast(enabled ? '已启用手动桌面端' : '已恢复自动识别');
      } catch (e) {
        checkbox.checked = !enabled;
        toast('保存失败：' + (e.message || '未知错误'));
      } finally {
        checkbox.disabled = false;
        updateLaunchRowState(row);
      }
    });
    manualSave.addEventListener('click', async () => {
      const target = input.value.trim();
      if (!checkbox.checked || !target) return;
      manualSave.disabled = true;
      try {
        await saveLaunchOverrideSetting(id, true, target);
        toast('已保存手动桌面端，正在切换…');
        await launchAgent(id, 'desktop');
      } catch (e) {
        toast('保存失败：' + (e.message || '未知错误'));
      } finally {
        updateLaunchRowState(row);
      }
    });
    autoButtons.forEach((button) => {
      button.addEventListener('click', () => launchAgent(id, button.dataset.target));
    });
  });
}

/* ---------- Agent 显示管理 ---------- */
function openColManager() {
  closePopover();
  state.popoverFor = 'cols';
  const pop = document.createElement('div');
  pop.className = 'popover';
  pop.style.position = 'fixed';
  pop.style.top = '70px';
  pop.style.right = '16px';
  pop.style.zIndex = 60;
  pop.style.minWidth = '300px';
  document.body.appendChild(pop);
  const current = effectiveCols();
  const items = [...state.agentIds];
  let html = `<div class="pop-head">Agent 显示设置 <span style="opacity:.5;font-weight:400">（勾选显示，上下拖动顺序）</span></div>
    <fieldset class="subagent-style-settings">
      <legend>子代理卡片显示</legend>
      <label class="subagent-style-option">
        <input type="radio" name="subagent-card-style" value="flat" ${state.subagentCardStyle === 'flat' ? 'checked' : ''}>
        <span class="subagent-style-copy"><span>平铺卡片</span><small>子代理按普通卡片平铺显示</small></span>
      </label>
      <label class="subagent-style-option">
        <input type="radio" name="subagent-card-style" value="stacked" ${state.subagentCardStyle === 'stacked' ? 'checked' : ''}>
        <span class="subagent-style-copy"><span>卡片对叠</span><small>子代理卡片叠放在父卡片下方</small></span>
      </label>
    </fieldset>
    <div style="padding:6px 8px;max-height:56vh;overflow-y:auto">`;
  for (const id of items) {
    const meta = id === 'all' ? { name: '全部', color: '#888780' } : agentMeta(id);
    const on = current.includes(id);
    html += `<div class="col-mgr-row" data-id="${esc(id)}" style="display:flex;align-items:center;gap:8px;padding:7px 6px;border-radius:7px;cursor:move">
      <input type="checkbox" class="col-mgr-cb" ${on ? 'checked' : ''} style="width:15px;height:15px;accent-color:${meta.color}">
      <span class="dot" style="width:8px;height:8px;border-radius:50%;background:${meta.color}"></span>
      <span style="flex:1;font-size:13px">${esc(meta.name)}</span>
      <span style="font-size:11px;color:var(--text3)">${(state.board[id]||[]).length} 条</span>
      <span style="cursor:grab;opacity:.5">⠿</span>
    </div>`;
  }
  html += `</div>
    <div style="display:flex;gap:8px;padding:8px 10px;border-top:1px solid var(--border)">
      <button class="btn" style="flex:1;min-height:36px;padding:6px 10px;font-size:13px" id="cols-done">完成</button>
      <button class="btn" style="min-height:36px;padding:6px 10px;font-size:13px" id="cols-reset">恢复默认</button>
    </div>`;
  pop.innerHTML = html;

  pop.querySelectorAll('input[name="subagent-card-style"]').forEach((radio) => radio.addEventListener('change', () => {
    if (!radio.checked) return;
    const style = sessionCardStacking.normalizeSubagentCardStyle(radio.value);
    state.subagentCardStyle = sessionCardStacking.saveSubagentCardStyle(subagentStorage, style);
    state.expandedSubagentGroups.clear();
    renderBoard();
  }));

  // 勾选 → 更新显示
  const applyCols = () => {
    const order = [];
    const cbs = pop.querySelectorAll('.col-mgr-row');
    for (const row of cbs) {
      const id = row.dataset.id;
      const cb = row.querySelector('.col-mgr-cb');
      if (cb.checked) order.push(id);
    }
    state.colOrder = order;
    try { saveColOrder(order); } catch {}
    renderBoard();
  };
  pop.querySelectorAll('.col-mgr-cb').forEach((cb) => cb.addEventListener('change', applyCols));

  // 简单拖拽排序（HTML5 drag 接口）
  let dragEl = null;
  pop.querySelectorAll('.col-mgr-row').forEach((row) => {
    row.draggable = true;
    row.addEventListener('dragstart', (e) => {
      dragEl = row;
      row.style.opacity = '.4';
      e.dataTransfer.effectAllowed = 'move';
    });
    row.addEventListener('dragend', () => { row.style.opacity = ''; dragEl = null; });
    row.addEventListener('dragover', (e) => { e.preventDefault(); });
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      if (!dragEl || dragEl === row) return;
      const box = pop.querySelector('.col-mgr-row').parentElement;
      const rows = [...box.querySelectorAll('.col-mgr-row')];
      const from = rows.indexOf(dragEl), to = rows.indexOf(row);
      if (from < 0 || to < 0) return;
      box.insertBefore(dragEl, to > from ? row.nextSibling : row);
      applyCols();
    });
  });

  pop.querySelector('#cols-done').onclick = () => { applyCols(); closePopover(); toast('Agent 显示设置已保存'); };
  pop.querySelector('#cols-reset').onclick = () => {
    // 恢复默认＝恢复到「探测为已安装或有历史数据」过滤后的默认列，不是恢复成全部 agent
    state.colOrder = null;
    sessionCardStacking.saveSubagentCardStyle(subagentStorage, 'flat');
    state.subagentCardStyle = 'flat';
    state.expandedSubagentGroups.clear();
    try { saveColOrder(['all', ...state.defaultAgentIds]); } catch {}
    closePopover();
    loadBoard();
  };
}
$('btn-settings-hub').onclick = openSettingsHub;

/* ---------- 应用管理（探测路径 + 官方下载入口） ---------- */

const AGENT_INSTALL_SKILL_URL = '/downloads/agent-board-install-agents.skill';
const AGENT_INSTALL_SKILL_PROMPT = '请调用 Agent Board Agent Installer skill，先询问我安装全部 Agent 还是选择指定 Agent，得到我的选择后再执行安装。';

function agentManagerGuideMarkup(agents = []) {
  const missing = agents.filter((agent) => !agent.installed && agent.aiInstallable && agent.install && agent.install.downloadUrl);
  const targetOptions = missing.length
    ? missing.map((agent) => `<option value="${esc(agent.id)}">${esc(agent.name || agent.id)}</option>`).join('')
    : '<option value="">没有待安装的 Agent</option>';
  return `<section class="ab-install-guide" aria-label="AI 安装指引">
    <div class="ab-guide-heading"><span class="ab-guide-kicker">快捷安装</span><span>让 AI 帮你安装 Agent</span></div>
    <div class="ab-guide-copy">先安装 Agent Board 安装 Skill。调用后，AI 会先询问安装全部还是选择几个，再按你的选择处理。</div>
    <div class="ab-guide-steps">
      <div class="ab-guide-step"><b>01 · 安装</b>下载 Skill 文件，并在你的 AI 客户端中安装。</div>
      <div class="ab-guide-step"><b>02 · 调用</b>发送下方指令，让 AI 先确认安装范围。</div>
      <div class="ab-guide-step"><b>03 · 校验</b>安装完成后重新探测并配置启动路径。</div>
    </div>
    <div class="ab-guide-actions">
      <a class="btn primary ab-skill-download" href="${AGENT_INSTALL_SKILL_URL}" download="agent-board-install-agents.skill">下载安装 Skill</a>
      <button class="btn ab-copy-skill-prompt" type="button">复制调用指令</button>
    </div>
    <div class="ab-guide-prompt" title="${esc(AGENT_INSTALL_SKILL_PROMPT)}">${esc(AGENT_INSTALL_SKILL_PROMPT)}</div>
    <form class="ab-ai-install-panel" id="ab-ai-install-form">
      <div class="ab-ai-install-title">AI 自动安装（仅执行固定官方安装定义）</div>
      <div class="ab-ai-install-grid">
        <label class="ab-ai-field" for="ab-ai-agent"><span>安装目标</span><select id="ab-ai-agent" name="agentId" ${missing.length ? '' : 'disabled'}>${targetOptions}</select></label>
        <label class="ab-ai-field" for="ab-ai-provider"><span>AI 服务商</span><select id="ab-ai-provider" name="provider"><option value="openai">OpenAI 兼容接口</option><option value="anthropic">Anthropic</option></select></label>
        <label class="ab-ai-field" for="ab-ai-model"><span>模型</span><input id="ab-ai-model" name="model" type="text" value="gpt-4o-mini" autocomplete="off"></label>
        <label class="ab-ai-field" for="ab-ai-base-url"><span>接口地址（可选）</span><input id="ab-ai-base-url" name="baseUrl" type="url" placeholder="默认使用服务商官方地址" autocomplete="url"></label>
        <label class="ab-ai-field ab-ai-key-field" for="ab-ai-api-key"><span>AI 安装 API Key</span><input id="ab-ai-api-key" name="apiKey" type="password" autocomplete="off" required placeholder="仅本次安装使用，不写入配置"></label>
      </div>
      <div class="ab-ai-install-foot"><span class="ab-ai-help">AI 只生成安装动作；命令来自 Agent Board 固定白名单。桌面端会打开官方下载页，由你完成安装向导。</span><button class="btn primary ab-ai-install-submit" type="submit" ${missing.length ? '' : 'disabled'}>AI 自动安装</button></div>
      <div class="ab-ai-install-status" role="status" aria-live="polite"></div>
    </form>
  </section>`;
}

function agentManagerLoadingMarkup(force) {
  const text = force ? '正在重新探测应用状态…' : '正在检测应用状态…';
  return `<div class="pop-head ab-manager-head"><div class="ab-manager-heading"><div class="ab-manager-title">应用管理</div><div class="ab-manager-subtitle">检测 Agent 状态、下载入口和启动路径</div></div></div>
    <div role="status" style="padding:18px 16px;color:var(--text2);font-size:13px;display:flex;align-items:center;gap:8px">
      <span aria-hidden="true" style="width:12px;height:12px;border:2px solid var(--border2);border-top-color:var(--accent);border-radius:50%;animation:spin .7s linear infinite"></span>
      <span>${text}</span>
    </div>`;
}

async function discoverAgentPath(agent, button) {
  button.disabled = true;
  button.textContent = '探测中…';
  try {
    const d = await configureAgentPath(agent);
    toast(`${dataName(agent)}：已配置路径 ${d.path}`);
    await openAgentManager(true);
  } catch (e) {
    button.disabled = false;
    button.textContent = '自动配置路径';
    toast(e.message || '未找到可执行文件');
  }
}

function dataName(agent) {
  return state.agentsDef[agent]?.name || agent;
}

async function copyAgentInstallPrompt(button) {
  try {
    await navigator.clipboard.writeText(AGENT_INSTALL_SKILL_PROMPT);
    const original = button.textContent;
    button.textContent = '已复制';
    toast('调用指令已复制');
    setTimeout(() => { if (button.isConnected) button.textContent = original; }, 1400);
  } catch {
    toast('复制失败，请手动复制指引文字');
  }
}

async function runAiAgentInstall(agentId, button, form) {
  const keyInput = form.querySelector('#ab-ai-api-key');
  const target = form.querySelector('#ab-ai-agent');
  const apiKey = keyInput?.value.trim() || '';
  if (!agentId || !apiKey) {
    toast('请选择 Agent 并输入 AI 安装 API Key');
    keyInput?.focus();
    return;
  }
  const status = form.querySelector('.ab-ai-install-status');
  const controls = [...form.querySelectorAll('input, select, button')];
  controls.forEach((control) => { control.disabled = true; });
  if (status) status.textContent = 'AI 正在生成受控安装方案…';
  try {
    const result = await requestJson('/api/agent-installer/run', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId, provider: form.querySelector('#ab-ai-provider')?.value || 'openai',
        model: form.querySelector('#ab-ai-model')?.value.trim() || '',
        baseUrl: form.querySelector('#ab-ai-base-url')?.value.trim() || '', apiKey,
      }),
    });
    if (result.action === 'open_download' && /^https?:\/\//i.test(result.downloadUrl || '')) {
      window.open(result.downloadUrl, '_blank', 'noopener,noreferrer');
      toast(`${dataName(agentId)}：已打开官方下载页，请完成安装向导`);
    } else {
      toast(`${dataName(agentId)}：AI 安装已完成，正在重新探测`);
    }
    await openAgentManager(true, agentId);
  } catch (error) {
    if (status) status.textContent = error.message || 'AI 安装失败';
    toast(error.message || 'AI 安装失败');
    controls.forEach((control) => { if (control.isConnected) control.disabled = false; });
    if (target && target.isConnected) target.value = agentId;
    if (button?.isConnected) button.disabled = false;
  }
}

function manualPathForAgent(agent, kind) {
  const paths = agent.manualPaths && Array.isArray(agent.manualPaths[kind]) ? agent.manualPaths[kind] : [];
  return paths[0] || '';
}

function manualPathEditorMarkup(agent) {
  const defaultKind = agent.tier === 'cli' ? 'cli' : 'desktop';
  return `<div class="ab-manual-editor" hidden>
      <div class="ab-manual-variants">
        <label><input type="radio" name="manual-kind-${esc(agent.id)}" value="cli" ${defaultKind === 'cli' ? 'checked' : ''}> CLI</label>
        <label><input type="radio" name="manual-kind-${esc(agent.id)}" value="desktop" ${defaultKind === 'desktop' ? 'checked' : ''}> 桌面端</label>
      </div>
      <input class="ab-manual-input" type="text" placeholder="绝对路径，例如 D:\\deepseek\\DSH Desktop\\DSH Desktop.exe" value="${esc(manualPathForAgent(agent, defaultKind))}">
      <label class="ab-manual-sync"><input type="checkbox" class="ab-manual-sync-checkbox"> 桌面端同时设为启动路径</label>
      <div class="ab-manual-help">支持绝对路径 .exe / .cmd / .bat；手动配置优先于自动探测，保存后立即重新探测。</div>
      <div class="ab-manual-actions"><button class="btn primary ab-manual-save" type="button">校验并保存</button><button class="btn ab-manual-clear" type="button">清除当前变体</button></div>
    </div>`;
}

async function saveManualAgentPath(card, agent, clear = false) {
  const kind = card.querySelector('input[name="manual-kind-' + agent.id + '"]:checked')?.value || 'desktop';
  const input = card.querySelector('.ab-manual-input');
  const target = clear ? '' : (input?.value || '').trim();
  const saveButton = card.querySelector('.ab-manual-save');
  const clearButton = card.querySelector('.ab-manual-clear');
  saveButton.disabled = true;
  clearButton.disabled = true;
  try {
    const result = await requestJson('/api/agents/' + encodeURIComponent(agent.id) + '/override-path', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, path: target }),
    });
    if (kind === 'desktop' && card.querySelector('.ab-manual-sync-checkbox')?.checked) {
      await saveLaunchOverrideSetting(agent.id, Boolean(target), target);
    }
    await openAgentManager(true, agent.id);
    toast(result.warning || (clear ? '已清除手动配置，恢复自动探测' : '手动路径已保存，正在重新探测'));
  } catch (error) {
    toast(error.message || '保存手动路径失败');
  } finally {
    if (saveButton.isConnected) saveButton.disabled = false;
    if (clearButton.isConnected) clearButton.disabled = false;
  }
}

async function openAgentManager(force, focusAgent = '') {
  closePopover();
  state.popoverFor = 'agents';
  const pop = document.createElement('div');
  pop.className = 'popover ab-agent-manager';
  pop.style.position = 'fixed';
  pop.style.top = '70px';
  pop.style.right = '16px';
  pop.style.zIndex = 60;
  document.body.appendChild(pop);
  pop.innerHTML = agentManagerLoadingMarkup(force);

  let data;
  try {
    data = await requestJson('/api/agents/status' + (force ? '?force=1' : ''));
  } catch (error) {
    pop.innerHTML = `<div class="pop-head ab-manager-head"><div class="ab-manager-heading"><div class="ab-manager-title">应用管理</div><div class="ab-manager-subtitle">检测 Agent 状态、下载入口和启动路径</div></div></div><div style="padding:16px;color:var(--text3);font-size:13px">检测失败：${esc(error.message || '请求失败')}</div>`;
    return;
  }

  const agents = Object.values(data.agents || {});
  // 探测结果服务端有 5 分钟缓存，这里加个「重新探测」按钮手动跳过缓存（force=1）
  let html = `<div class="pop-head ab-manager-head"><div class="ab-manager-heading"><div class="ab-manager-title">应用管理</div><div class="ab-manager-subtitle">检测 Agent 状态、真实图标、安装变体和启动路径</div></div>
    <button class="btn ab-rescan-probe" type="button">重新探测</button>
  </div>${agentManagerGuideMarkup(agents)}<div class="ab-agent-grid">`;
  for (const a of agents) {
    const variantLabel = a.variant === 'desktop' ? ' Desktop' : a.variant === 'cli+desktop' ? ' CLI + Desktop' : '';
    const badge = a.installed
      ? `<span class="ab-status-badge installed">已安装${variantLabel}${a.version ? ' ' + esc(a.version) : ''}</span>`
      : `<span class="ab-status-badge missing">未检测到</span>`;
    const canInstall = !a.installed && (a.tier === 'cli' || a.tier === 'gui')
      && a.install && /^https?:\/\//i.test(a.install.downloadUrl || '');
    const canAiInstall = canInstall && a.aiInstallable;
    const btn = canInstall
      ? `<button class="btn ab-install" type="button" data-id="${esc(a.id)}" data-url="${esc(a.install.downloadUrl)}">打开下载页</button>`
      : '';
    const aiButton = canAiInstall
      ? `<button class="btn primary ab-ai-install" type="button" data-id="${esc(a.id)}">AI 自动安装</button>`
      : '';
    const manualKind = a.tier === 'cli' ? 'cli' : 'desktop';
    const manualPath = manualPathForAgent(a, manualKind);
    const shownPath = a.executablePath || a.desktopExecutablePath || a.path || manualPath;
    const pathLabel = a.source === 'override' || a.desktopSource === 'override'
      ? '手动配置路径'
      : a.executablePath ? (a.tier === 'gui' ? 'Desktop 路径' : 'CLI 路径')
        : (a.desktopExecutablePath ? 'Desktop 路径' : (a.path ? '数据路径' : (manualPath ? '手动配置路径' : '')));
    const pathMarkup = shownPath
      ? `<div class="ab-card-path" title="${esc(shownPath)}">${pathLabel}：${esc(shownPath)}</div>`
      : '<div class="ab-card-path empty">未配置启动路径</div>';
    const manualBadge = a.manualOverride?.cli || a.manualOverride?.desktop
      ? '<span class="ab-status-badge manual">手动配置</span>' : '';
    const probeOnlyBadge = a.probeOnly ? '<span class="ab-status-badge">仅探测</span>' : '';
    const discoverButton = a.probeOnly
      ? ''
      : `<button class="btn ab-discover-path" type="button" data-id="${esc(a.id)}">自动配置路径</button>`;
    html += `<div class="ab-card" data-id="${esc(a.id)}">
      <div class="ab-card-icon" style="background:${esc(a.color || '#888')}" title="${esc(a.name || a.id)}">${agentIconMarkup(a, 'ab-agent-icon')}</div>
      <div class="ab-card-main">
        <div class="ab-card-title-row"><div class="ab-card-title" title="${esc(a.name || a.id)}">${esc(a.name || a.id)}</div>${badge}${manualBadge}${probeOnlyBadge}</div>
        ${pathMarkup}
        ${manualPathEditorMarkup(a)}
        <div class="ab-progress" role="status" aria-live="polite"></div>
      </div>
      <div class="ab-card-actions"><button class="btn ab-manual-path" type="button">手动配置路径</button>${discoverButton}${aiButton}${btn}</div>
    </div>`;
  }
  html += '</div>';
  pop.innerHTML = html;

  if (focusAgent) {
    const card = [...pop.querySelectorAll('.ab-card')].find((item) => item.dataset.id === focusAgent);
    if (card) {
      card.scrollIntoView({ block: 'nearest' });
      card.style.outline = '2px solid var(--accent)';
      setTimeout(() => { if (card.isConnected) card.style.outline = ''; }, 2200);
    }
  }

  const rescanBtn = pop.querySelector('.ab-rescan-probe');
  if (rescanBtn) rescanBtn.onclick = () => openAgentManager(true);

  const copyPromptBtn = pop.querySelector('.ab-copy-skill-prompt');
  if (copyPromptBtn) copyPromptBtn.onclick = () => copyAgentInstallPrompt(copyPromptBtn);

  const aiForm = pop.querySelector('#ab-ai-install-form');
  if (aiForm) {
    aiForm.onsubmit = (event) => {
      event.preventDefault();
      const agentId = aiForm.querySelector('#ab-ai-agent')?.value || '';
      void runAiAgentInstall(agentId, event.submitter, aiForm);
    };
    pop.querySelectorAll('.ab-ai-install[data-id]').forEach((button) => {
      button.onclick = () => {
        const target = aiForm.querySelector('#ab-ai-agent');
        if (target) target.value = button.dataset.id || '';
        aiForm.querySelector('#ab-ai-api-key')?.focus();
        aiForm.requestSubmit();
      };
    });
  }

  pop.querySelectorAll('.ab-discover-path').forEach((b) => {
    b.onclick = () => discoverAgentPath(b.dataset.id, b);
  });

  pop.querySelectorAll('.ab-card').forEach((card) => {
    const agent = agents.find((item) => item.id === card.dataset.id);
    if (!agent) return;
    const editor = card.querySelector('.ab-manual-editor');
    const toggle = card.querySelector('.ab-manual-path');
    const input = card.querySelector('.ab-manual-input');
    toggle.onclick = () => {
      editor.hidden = !editor.hidden;
      toggle.textContent = editor.hidden ? '手动配置路径' : '收起手动配置';
    };
    card.querySelectorAll('input[name="manual-kind-' + agent.id + '"]').forEach((radio) => {
      radio.onchange = () => { input.value = manualPathForAgent(agent, radio.value); };
    });
    card.querySelector('.ab-manual-save').onclick = () => saveManualAgentPath(card, agent, false);
    card.querySelector('.ab-manual-clear').onclick = () => saveManualAgentPath(card, agent, true);
  });

  // 所有安装动作统一跳转官方下载页，不在看板内执行 npm/winget/脚本。
  pop.querySelectorAll('.ab-install').forEach((b) => {
    b.onclick = () => {
      const downloadUrl = b.dataset.url;
      if (!/^https?:\/\//i.test(downloadUrl || '')) {
        toast('没有可用的官方下载链接');
        return;
      }
      window.open(downloadUrl, '_blank', 'noopener,noreferrer');
      toast('已打开官方下载页，安装完成后点击“重新探测”刷新状态');
    };
  });
}
$('btn-agents').onclick = () => openAgentManager();

/* ---------- SSE ---------- */
const SSE_REFRESH_INTERVAL_MS = 5000;
function connectSSE() {
  const es = new EventSource('/api/events');
  // 新消息：刷新统计；看板防抖刷新（避免高频 message 触发全量重建造成状态闪烁/视觉跳动，
  // 重建时 buildCard 用 liveRefs 判定状态，不会闪回「已完成」）
  let boardTimer = null;
  let stateTimer = null;
  const refreshState = () => {
    if (stateTimer) return;
    stateTimer = setTimeout(() => { stateTimer = null; loadState(); }, SSE_REFRESH_INTERVAL_MS);
  };
  const refreshBoard = () => {
    if (boardTimer) return;
    boardTimer = setTimeout(() => { boardTimer = null; loadBoard(); }, SSE_REFRESH_INTERVAL_MS);
  };
  es.addEventListener('message', () => { refreshState(); refreshBoard(); });
  es.addEventListener('active', (ev) => {
    try {
      const payload = JSON.parse(ev.data);
      const arr = Array.isArray(payload) ? payload : (Array.isArray(payload.active) ? payload.active : []);
      if (!Array.isArray(payload) && payload.statuses && typeof payload.statuses === 'object') {
        state.runtimeStatuses = new Map(Object.entries(payload.statuses));
      }
      // 兼容两种条目结构：getActive() 返回 {sessionRef}；心跳曾返回 {sessionId}
      // 且只认 active 明确为 true 的条目（防御：任何来源都不该把 inactive 会话当活跃）
      const liveSet = new Set(
        arr
          .filter((a) => a.active !== false)
          .map((a) => {
            const ref = a.sessionRef || (a.agent && a.sessionId ? a.agent + ':' + a.sessionId : null);
            if (ref && (a.session_role === 'child' || a.session_role === 'main')) state.sessionRoles.set(ref, a.session_role);
            return ref;
          })
          .filter(Boolean)
      );
      state.liveRefs = liveSet; // 权威状态
      // 进行中 → 已完成 迁移检测：用上一份快照对比本次快照（覆盖 liveRefs 之前取旧值），
      // 离开活跃窗口的会话标记为「刚完成」（绿色流光）。首次快照只建立基线，不误标。
      if (state._activeInit) {
        for (const ref of state._prevRefs) {
          const runtime = state.runtimeStatuses.get(ref);
          if (!liveSet.has(ref) && (!runtime || runtime.state === 'completed')) markRecentlyCompleted(ref);
        }
      }
      state._activeInit = true;
      state._prevRefs = liveSet;
      // 逐卡差异化更新：新状态与卡上记录的当前状态（data-live）对比——
      // 一样的完全跳过（不触碰 DOM），只有变化的卡才单独切换。
      // 避免对全部 session 卡做无意义的 class/标签重写造成视觉闪烁。
      document.querySelectorAll('#board .s-card').forEach((el) => {
        const ref = el.querySelector('.s-more')?.dataset.ref;
        if (!ref) return;
        const nowLive = liveSet.has(ref);
        const prevLive = el.dataset.live === '1';
        const runtime = state.runtimeStatuses.get(ref);
        const status = runtime && runtime.state ? runtime.state : (nowLive ? 'running' : 'completed');
        const prevStatus = el.dataset.runtimeStatus || (prevLive ? 'running' : 'completed');
        if (nowLive !== prevLive || status !== prevStatus) {
          // 状态变化：单独更新这一张卡
          el.dataset.live = nowLive ? '1' : '0';
          el.dataset.runtimeStatus = status;
          applyStatusClass(el, status);
          const lbl = el.querySelector('.s-status');
          if (lbl) lbl.outerHTML = statusMarkup(status);
        }
        // 流光装饰与状态解耦刷新：新完成迁移后立即点亮绿色流光（含「已读」按钮）
        applyFlowDecor(el, ref, nowLive);
      });
    } catch {}
  });
  es.addEventListener('completion', (ev) => {
    try {
      const payload = JSON.parse(ev.data);
      Promise.resolve(window.AgentBoardDesktop?.notifyCompletion?.(payload.sessionId)).catch(() => {});
    } catch {}
  });
  es.addEventListener('scan', (ev) => {
    try {
      const d = JSON.parse(ev.data);
      if (d.finished) { toast('数据扫描完成'); loadState(); loadBoard(); }
    } catch {}
  });
  es.addEventListener('hide', (ev) => {
    try {
      const d = JSON.parse(ev.data);
      const set = new Set(d.sessions.map((x) => x.agent + ':' + x.sessionId));
      for (const k of Object.keys(state.board)) {
        state.board[k] = state.board[k].filter((s) => !set.has(s.agent + ':' + s.session_id));
      }
      renderBoard();
    } catch {}
  });
  es.addEventListener('unhide', () => { loadBoard(); });
  es.addEventListener('orchestration', () => { loadOrchestration(); });
  es.onerror = () => {
    setRuntimeHealth('实时连接中断 · 正在自动重连', 'warning');
  };
}

/* ---------- Toast ---------- */
let toastTimer = null;
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}

function registerDesktopJumpShortcut() {
  const desktop = window.AgentBoardDesktop;
  if (typeof desktop?.onJumpToLatestCompleted !== 'function') return;
  desktop.onJumpToLatestCompleted(() => { void jumpToLatestCompleted(); });
}

/* ---------- 启动 ---------- */
registerDesktopJumpShortcut();
(async () => {
  loadRecentDone();
  await loadState();
  await loadBoard();
  await loadOrchestration();
  await loadHealth();
  await loadCompletionSounds();
  connectSSE();
  setInterval(loadHealth, 10000);
})();
