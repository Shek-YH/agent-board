'use strict';

const crypto = require('node:crypto');

const { createWorkflowRequest, createSessionWorkflowRequest, createSessionIntakeWorkflowRequest, previewSessionTaskIntake, previewProjectTaskIntake, createConfirmedTask, duplicateSessions, getOrchestrationState, getRoutingConfig, takeoverWorkflow, transitionWorkflow, updateRoutingConfig, resolveSessionContext, assertAllowedProject } = require('./api');
const { discoverPrdCandidates, generatePrdGoalDraft } = require('./project-prd');
const {
  buildRoutingDiagnostics,
  buildRoutingTimeline,
  buildRoutingUsage,
  buildSafeReceipt,
} = require('./routing/commercial');
const {
  aggregateRoutingOutcomes,
  aggregateWorkspaceRoutingOutcomes,
  recommendHistoricalProfile,
  recommendExecutionProfile,
  checkRoutingWorkspace,
} = require('./routing/insights');

function routeMatch(pathname, pattern) {
  const match = String(pathname || '').match(pattern);
  return match ? match[1] : null;
}

const TASK_DRAFT_TTL_MS = 15 * 60 * 1000;

function saveTaskDraft(runtime, result) {
  if (!runtime.taskDrafts || typeof runtime.taskDrafts.set !== 'function') runtime.taskDrafts = new Map();
  const now = Date.now();
  for (const [id, draft] of runtime.taskDrafts) {
    if (!draft || now - draft.createdAt > TASK_DRAFT_TTL_MS) runtime.taskDrafts.delete(id);
  }
  const id = `draft-${crypto.randomUUID()}`;
  runtime.taskDrafts.set(id, {
    id,
    createdAt: now,
    consumed: false,
    agent: String(result.agent || result.session?.agent || '').trim().toLowerCase(),
    projectPath: String(result.projectContext?.projectPath || result.session?.projectPath || '').trim(),
    taskContract: result.taskContract,
    sessionRef: String(result.session?.sessionRef || '').trim(),
  });
  return id;
}

function readTaskDraft(runtime, id) {
  const draft = runtime.taskDrafts && typeof runtime.taskDrafts.get === 'function'
    ? runtime.taskDrafts.get(String(id || '')) : null;
  if (!draft || Date.now() - draft.createdAt > TASK_DRAFT_TTL_MS || draft.consumed) return null;
  return draft;
}

function mergeSettingsPatch(runtime, patch) {
  const base = runtime.settings && typeof runtime.settings.get === 'function'
    ? runtime.settings.get() : {};
  const source = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
  return {
    ...base,
    ...source,
    autopilot: { ...(base.autopilot || {}), ...(source.autopilot || {}) },
    routing: { ...(base.routing || {}), ...(source.routing || {}) },
    safety: { ...(base.safety || {}), ...(source.safety || {}) },
  };
}

async function routingCatalog(runtime, workflow) {
  if (!runtime.routing || typeof runtime.routing.getCatalog !== 'function') {
    return { source: 'unavailable', models: [], available: false, stale: false, reasonCode: 'CATALOG_UNAVAILABLE' };
  }
  return runtime.routing.getCatalog({ agent: workflow && workflow.agent });
}

function safeCatalog(catalog) {
  const value = catalog && typeof catalog === 'object' ? catalog : {};
  return {
    source: String(value.source || 'unavailable').slice(0, 40),
    available: value.available === true,
    stale: value.stale === true,
    reasonCode: value.reasonCode ? String(value.reasonCode).slice(0, 80) : null,
    fetchedAt: value.fetchedAt || null,
    agentVersion: value.agentVersion ? String(value.agentVersion).slice(0, 80) : null,
    models: Array.isArray(value.models) ? value.models.map((model) => ({
      id: String(model && model.id || '').slice(0, 200),
      displayName: String(model && (model.displayName || model.id) || '').slice(0, 200),
      description: String(model && model.description || '').slice(0, 500),
      defaultReasoningLevel: model && model.defaultReasoningLevel || null,
      supportedReasoningLevels: Array.isArray(model && model.supportedReasoningLevels)
        ? model.supportedReasoningLevels.map((level) => String(level).slice(0, 30)) : [],
      version: model && model.version ? String(model.version).slice(0, 80) : null,
      multiAgentVersion: model && model.multiAgentVersion ? String(model.multiAgentVersion).slice(0, 80) : null,
      visibility: String(model && model.visibility || 'list').slice(0, 30),
      supportedInApi: model && model.supportedInApi !== false,
      legacy: model && model.legacy === true,
      contextWindow: Number.isFinite(Number(model && model.contextWindow)) ? Number(model.contextWindow) : null,
      maxContextWindow: Number.isFinite(Number(model && model.maxContextWindow)) ? Number(model.maxContextWindow) : null,
    })).filter((model) => model.id) : [],
  };
}

function supportedRoutingAgents(runtime) {
  if (runtime.routing && typeof runtime.routing.supportedAgents === 'function') {
    return runtime.routing.supportedAgents();
  }
  return ['codex'];
}

function routingCapabilityMap(runtime) {
  const routing = runtime.routing;
  const agents = routing && typeof routing.capabilityAgents === 'function'
    ? routing.capabilityAgents() : supportedRoutingAgents(runtime);
  if (!routing || typeof routing.getCapabilityStatus !== 'function') return {};
  return Object.fromEntries(agents.map((agent) => [agent, routing.getCapabilityStatus({ agent })]));
}

async function routingOverview(runtime, workflow) {
  const catalog = await routingCatalog(runtime, workflow);
  const config = workflow.routingConfig || {};
  const modelOrder = Array.isArray(config.modelOrder) && config.modelOrder.length
    ? config.modelOrder : (Array.isArray(catalog.models) ? catalog.models.map((model) => model.id) : []);
  const outcomes = aggregateRoutingOutcomes({
    dispatchRecords: runtime.store && typeof runtime.store.listDispatchRecords === 'function'
      ? runtime.store.listDispatchRecords(workflow.id) : [],
  });
  const recommendation = recommendExecutionProfile({
    catalog, modelOrder, complexityTier: config.complexityTier, thinkingTier: config.thinkingTier,
    promptPolicy: config.promptPolicy, manualPin: config.manualPin, outcomes,
  });
  return {
    workflowId: workflow.id,
    diagnostics: buildRoutingDiagnostics({ workflow, catalog, supportedAgents: supportedRoutingAgents(runtime) }),
    auditTimeline: buildRoutingTimeline(workflow),
    usage: buildRoutingUsage(workflow),
    receipt: buildSafeReceipt(workflow),
    insights: {
      outcomes,
      recommendation,
      workspace: checkRoutingWorkspace({ projectPath: workflow.projectPath, allowedRoots: runtime.allowedRoots }),
    },
  };
}

async function workspaceRoutingRecommendations(runtime, outcomes) {
  const supportedAgents = new Set(supportedRoutingAgents(runtime).map((agent) => String(agent || '').trim().toLowerCase()));
  const taskClasses = (Array.isArray(outcomes && outcomes.taskClasses) ? outcomes.taskClasses : [])
    .filter((item) => item && item.taskClass && item.taskClass !== 'unknown' && supportedAgents.has(String(item.agent || '').toLowerCase()));
  const agents = [...new Set(taskClasses.map((item) => String(item.agent).toLowerCase()))];
  const catalogs = new Map(await Promise.all(agents.map(async (agent) => {
    try { return [agent, await routingCatalog(runtime, { agent })]; }
    catch { return [agent, { available: false, models: [], reasonCode: 'CATALOG_UNAVAILABLE' }]; }
  })));
  return taskClasses.map((item) => {
    const agent = String(item.agent).toLowerCase();
    const catalog = catalogs.get(agent) || { available: false, models: [] };
    const modelOrder = Array.isArray(catalog.models) ? catalog.models.map((model) => model && model.id).filter(Boolean) : [];
    const recommendation = recommendHistoricalProfile({
      catalog, modelOrder, agent, taskClass: item.taskClass, taskProfiles: outcomes.taskProfiles,
    });
    return {
      agent, taskClass: item.taskClass, sampleSize: recommendation.sampleSize,
      minAttempts: recommendation.minAttempts, reasonCode: recommendation.reasonCode,
      profile: recommendation.profile || null,
    };
  });
}

async function handleOrchestrationRequest({ method, pathname, query, body = {}, runtime }) {
  if (!String(pathname || '').startsWith('/api/orchestration/')) return null;
  if (!runtime) throw new Error('orchestration runtime is required');
  const verb = String(method || 'GET').toUpperCase();
  const params = query || new URLSearchParams();
  if (pathname === '/api/orchestration/routing/insights' && verb === 'GET') {
    const workflows = runtime.store && typeof runtime.store.list === 'function' ? runtime.store.list() : [];
    const dispatchRecords = runtime.store && typeof runtime.store.listDispatchRecords === 'function'
      ? runtime.store.listDispatchRecords() : [];
    const events = runtime.store && typeof runtime.store.listEvents === 'function' ? runtime.store.listEvents() : [];
    const outcomes = aggregateWorkspaceRoutingOutcomes({ dispatchRecords, workflows, events });
    return {
      status: 200,
      body: {
        scope: 'workspace',
        ...outcomes,
        recommendations: await workspaceRoutingRecommendations(runtime, outcomes),
      },
    };
  }
  if (pathname === '/api/orchestration/routing/catalog' && verb === 'GET') {
    const agent = String(params.get('agent') || 'codex').trim().toLowerCase();
    const catalog = runtime.routing && typeof runtime.routing.getCatalog === 'function'
      ? await runtime.routing.getCatalog({ agent })
      : { source: 'unavailable', models: [], available: false, stale: false, reasonCode: 'CATALOG_UNAVAILABLE' };
    return {
      status: 200,
      body: {
        supportedAgents: supportedRoutingAgents(runtime),
        capabilities: routingCapabilityMap(runtime),
        catalog: safeCatalog(catalog),
      },
    };
  }
  if (pathname === '/api/orchestration/routing/catalog/refresh' && verb === 'POST') {
    const agent = String(body.agent || 'codex').trim().toLowerCase();
    if (!supportedRoutingAgents(runtime).includes(agent)) {
      return { status: 409, body: { ok: false, code: 'ROUTING_AGENT_UNSUPPORTED', error: '当前 Agent 不支持 Model Routing' } };
    }
    const catalog = runtime.routing && typeof runtime.routing.refreshCatalog === 'function'
      ? await runtime.routing.refreshCatalog({ agent })
      : runtime.routing && typeof runtime.routing.getCatalog === 'function'
        ? await runtime.routing.getCatalog({ agent }) : { source: 'unavailable', models: [], available: false, reasonCode: 'CATALOG_UNAVAILABLE' };
    return { status: 200, body: { ok: true, agent, catalog: safeCatalog(catalog), capability: runtime.routing && typeof runtime.routing.getCapabilityStatus === 'function' ? runtime.routing.getCapabilityStatus({ agent }) : {} } };
  }
  if (pathname === '/api/orchestration/state' && verb === 'GET') {
    return {
      status: 200,
      body: {
        ...getOrchestrationState({ store: runtime.store, env: runtime.env }),
        settings: runtime.settings && typeof runtime.settings.get === 'function' ? runtime.settings.get() : null,
        allowedRoots: runtime.allowedRoots,
        headlessEnabled: runtime.headlessEnabled,
        routingCapabilities: routingCapabilityMap(runtime),
        jarvisVoice: runtime.jarvisVoice && typeof runtime.jarvisVoice.readiness === 'function' ? runtime.jarvisVoice.readiness() : null,
      },
    };
  }
  if (pathname === '/api/orchestration/settings' && verb === 'GET') {
    if (!runtime.settings || typeof runtime.settings.get !== 'function') {
      return { status: 503, body: { ok: false, code: 'SETTINGS_UNAVAILABLE', error: 'AutoPilot 设置存储未就绪' } };
    }
    return { status: 200, body: { settings: runtime.settings.get() } };
  }
  if (pathname === '/api/orchestration/settings' && (verb === 'PUT' || verb === 'POST')) {
    if (!runtime.settings || typeof runtime.settings.update !== 'function') {
      return { status: 503, body: { ok: false, code: 'SETTINGS_UNAVAILABLE', error: 'AutoPilot 设置存储未就绪' } };
    }
    return { status: 200, body: { ok: true, settings: runtime.settings.update(body) } };
  }
  if (pathname === '/api/orchestration/workflows' && verb === 'GET') {
    return { status: 200, body: { items: runtime.store.list() } };
  }
  if (pathname === '/api/orchestration/workflows' && verb === 'POST') {
    const result = createWorkflowRequest({
      projectPath: body.projectPath,
      goal: body.goal,
      mode: body.mode,
      agent: body.agent,
      autopilotMode: body.autopilotMode,
      scope: body.scope,
      verify: body.verify,
      budget: body.budget,
      binding: body.binding,
      routingConfig: body.routingConfig,
      requestedBy: body.requestedBy || 'human',
      allowedRoots: runtime.allowedRoots,
      store: runtime.store,
      settings: runtime.settings && typeof runtime.settings.get === 'function' ? runtime.settings.get() : undefined,
    });
    runtime.notify(result.workflow);
    return { status: 201, body: { ok: true, ...result } };
  }
  if (pathname === '/api/orchestration/prd/candidates' && verb === 'GET') {
    if (!runtime.sessionStore && !params.get('projectPath')) {
      return { status: 503, body: { ok: false, code: 'SESSION_RESOLVER_UNAVAILABLE', error: 'Session 解析服务未就绪' } };
    }
    try {
      const sessionRef = String(params.get('sessionRef') || '').trim();
      let projectPath = String(params.get('projectPath') || '').trim();
      let session = null;
      if (sessionRef) {
        const context = resolveSessionContext({ sessionRef, sessionStore: runtime.sessionStore });
        projectPath = context.projectPath;
        session = { sessionRef: context.ref, agent: context.agent, projectPath: context.projectPath };
      }
      if (!projectPath) {
        return { status: 400, body: { ok: false, code: 'PROJECT_PATH_REQUIRED', error: 'projectPath or sessionRef is required' } };
      }
      assertAllowedProject(projectPath, runtime.allowedRoots);
      const items = discoverPrdCandidates({ projectPath, allowedRoots: runtime.allowedRoots });
      const trusted = items.filter((item) => item.highConfidence);
      const selectable = trusted.length ? trusted : items;
      return {
        status: 200,
        body: {
          ok: true, items, selectionRequired: selectable.length > 1,
          autoSelectedPath: selectable.length === 1 ? selectable[0].path : null,
          ...(session ? { session } : {}),
        },
      };
    } catch (error) {
      if (error && error.code) return { status: Number(error.statusCode) || 400, body: { ok: false, code: error.code, error: error.message } };
      throw error;
    }
  }
  if (pathname === '/api/orchestration/intake/preview' && verb === 'POST') {
    try {
      if (body.sessionRef) {
        if (!runtime.sessionStore) return { status: 503, body: { ok: false, code: 'SESSION_RESOLVER_UNAVAILABLE', error: 'Session 解析服务未就绪' } };
        const result = await previewSessionTaskIntake({
          sessionRef: body.sessionRef, goal: body.goal, prdMode: body.prdMode, prdPath: body.prdPath,
          sessionStore: runtime.sessionStore, allowedRoots: runtime.allowedRoots, env: runtime.env,
        });
        result.agent = result.session.agent;
        result.projectContext = { ok: true, projectPath: result.session.projectPath, exists: true, isDirectory: true, readable: true, writable: true, git: null, secretFiles: [], warnings: [] };
        result.existingSessions = duplicateSessions({ sessionStore: runtime.sessionStore, agent: result.session.agent, projectPath: result.session.projectPath });
        const draftId = saveTaskDraft(runtime, result);
        return { status: 200, body: { ok: true, ...result, draftId } };
      }
      const result = await previewProjectTaskIntake({
        agent: body.agent, projectPath: body.projectPath, goal: body.goal, prdMode: body.prdMode, prdPath: body.prdPath,
        sessionStore: runtime.sessionStore, allowedRoots: runtime.allowedRoots, env: runtime.env,
      });
      const draftId = saveTaskDraft(runtime, result);
      return { status: 200, body: { ok: true, ...result, draftId } };
    } catch (error) {
      if (error && error.code) {
        return {
          status: Number(error.statusCode) || 400,
          body: { ok: false, code: error.code, error: error.message, ...(Array.isArray(error.candidates) ? { candidates: error.candidates } : {}) },
        };
      }
      throw error;
    }
  }
  if (pathname === '/api/orchestration/intake/confirm' && verb === 'POST') {
    const decision = String(body.decision || '').trim().toLowerCase();
    const draft = readTaskDraft(runtime, body.draftId);
    if (decision === 'cancel' || body.confirmed === false) {
      if (draft) runtime.taskDrafts.delete(draft.id);
      return { status: 200, body: { ok: true, cancelled: true, created: false } };
    }
    if (body.confirmed !== true && decision !== 'confirm') {
      return { status: 409, body: { ok: false, code: 'TASK_CONTRACT_CONFIRMATION_REQUIRED', error: '必须先明确确认 Task Contract' } };
    }
    if (!draft) return { status: 409, body: { ok: false, code: 'TASK_DRAFT_NOT_FOUND', error: 'Task Contract 草稿不存在或已过期' } };
    try {
      const result = await createConfirmedTask({
        draft, taskContract: body.taskContract, sessionChoice: body.sessionChoice || 'new', sessionRef: body.sessionRef,
        sessionStore: runtime.sessionStore, sessionProvisioners: runtime.sessionProvisioners,
        settings: mergeSettingsPatch(runtime, body.settings),
        allowedRoots: runtime.allowedRoots, store: runtime.store, requestedBy: body.requestedBy || 'human',
      });
      draft.consumed = true;
      runtime.taskDrafts.delete(draft.id);
      if (result.workflow) runtime.notify(result.workflow);
      return { status: result.bypass ? 200 : result.requiresApproval ? 202 : 201, body: { ok: true, created: true, ...result } };
    } catch (error) {
      if (error && error.code) return { status: Number(error.statusCode) || 409, body: { ok: false, code: error.code, error: error.message } };
      throw error;
    }
  }
  if (pathname === '/api/orchestration/workflows/from-session' && verb === 'POST') {
    if (!runtime.sessionStore) return { status: 503, body: { ok: false, code: 'SESSION_RESOLVER_UNAVAILABLE', error: 'Session 解析服务未就绪' } };
    if (body.confirmed !== true && body.decision !== 'confirm') {
      return { status: 409, body: { ok: false, code: 'TASK_CONTRACT_CONFIRMATION_REQUIRED', error: '必须先明确确认 Task Contract' } };
    }
    try {
      const result = await createSessionIntakeWorkflowRequest({
        sessionRef: body.sessionRef,
        goal: body.goal,
        prdMode: body.prdMode,
        prdPath: body.prdPath,
        sessionStore: runtime.sessionStore,
        settings: runtime.settings && typeof runtime.settings.get === 'function' ? runtime.settings.get() : undefined,
        allowedRoots: runtime.allowedRoots,
        store: runtime.store,
        requestedBy: body.requestedBy || 'human',
        env: runtime.env,
      });
      if (result.workflow) runtime.notify(result.workflow);
      return { status: result.bypass ? 200 : result.requiresApproval ? 202 : 201, body: { ok: true, ...result } };
    } catch (error) {
      if (error && error.code) {
        return {
          status: Number(error.statusCode) || 409,
          body: { ok: false, code: error.code, error: error.message, ...(Array.isArray(error.candidates) ? { candidates: error.candidates } : {}) },
        };
      }
      throw error;
    }
  }
  if (pathname === '/api/orchestration/prd-draft' && verb === 'POST') {
    if (!runtime.sessionStore) return { status: 503, body: { ok: false, code: 'SESSION_RESOLVER_UNAVAILABLE', error: 'Session 解析服务未就绪' } };
    try {
      const context = resolveSessionContext({ sessionRef: body.sessionRef, sessionStore: runtime.sessionStore });
      assertAllowedProject(context.projectPath, runtime.allowedRoots);
      const result = await generatePrdGoalDraft({ projectPath: context.projectPath, env: runtime.env });
      return { status: 200, body: { ok: true, sessionRef: context.ref, agent: context.agent, prd: result.prd, source: result.source, warning: result.warning || null, draft: result.draft } };
    } catch (error) {
      if (error && ['SESSION_TARGET_UNRESOLVED', 'SESSION_METADATA_UNVERIFIED', 'PROJECT_PRD_NOT_FOUND', 'PROJECT_PRD_PROJECT_NOT_FOUND', 'PROJECT_PRD_PROJECT_INVALID', 'PROJECT_PRD_TOO_LARGE', 'PROJECT_PRD_UNREADABLE'].includes(error.code)) {
        return { status: Number(error.statusCode) || 409, body: { ok: false, code: error.code, error: error.message } };
      }
      throw error;
    }
  }

  const id = routeMatch(pathname, /^\/api\/orchestration\/workflows\/([^/]+)$/);
  if (id && verb === 'GET') {
    const workflow = runtime.store.get(decodeURIComponent(id));
    return workflow ? { status: 200, body: workflow } : { status: 404, body: { code: 'WORKFLOW_NOT_FOUND', error: 'workflow not found' } };
  }
  const takeoverId = routeMatch(pathname, /^\/api\/orchestration\/workflows\/([^/]+)\/takeover$/);
  if (takeoverId && verb === 'POST') {
    const workflow = takeoverWorkflow({ store: runtime.store, id: decodeURIComponent(takeoverId), owner: body.owner || 'human' });
    runtime.notify(workflow);
    return { status: 200, body: { ok: true, workflow } };
  }

  const routingId = routeMatch(pathname, /^\/api\/orchestration\/workflows\/([^/]+)\/routing$/);
  if (routingId && verb === 'GET') {
    const routing = getRoutingConfig({ store: runtime.store, id: decodeURIComponent(routingId), supportedAgents: supportedRoutingAgents(runtime) });
    if (!routing) return { status: 404, body: { code: 'WORKFLOW_NOT_FOUND', error: 'workflow not found' } };
    return { status: 200, body: { ...routing, catalog: runtime.routing && typeof runtime.routing.getCatalog === 'function' ? safeCatalog(await runtime.routing.getCatalog({ agent: routing.agent })) : null } };
  }
  if (routingId && verb === 'POST') {
    const workflow = updateRoutingConfig({ store: runtime.store, id: decodeURIComponent(routingId), config: body.config || body, supportedAgents: supportedRoutingAgents(runtime) });
    if (!workflow) return { status: 404, body: { code: 'WORKFLOW_NOT_FOUND', error: 'workflow not found' } };
    runtime.notify(workflow);
    return { status: 200, body: { ok: true, workflow, routing: workflow.routingConfig } };
  }
  const routingTestId = routeMatch(pathname, /^\/api\/orchestration\/workflows\/([^/]+)\/routing\/test$/);
  if (routingTestId && verb === 'POST') {
    const workflow = runtime.store.get(decodeURIComponent(routingTestId));
    if (!workflow) return { status: 404, body: { code: 'WORKFLOW_NOT_FOUND', error: 'workflow not found' } };
    if (!runtime.routing || typeof runtime.routing.testProfile !== 'function') {
      return { status: 503, body: { ok: false, code: 'PROFILE_TEST_UNAVAILABLE', error: '当前 Agent 不支持模型切换测试' } };
    }
    const modelId = typeof body.modelId === 'string' ? body.modelId.trim().slice(0, 200) : '';
    const reasoningLevel = typeof body.reasoningLevel === 'string' ? body.reasoningLevel.trim().toLowerCase().slice(0, 30) : null;
    if (!modelId) return { status: 400, body: { ok: false, code: 'MODEL_ID_REQUIRED', error: 'modelId is required' } };
    let result;
    try {
      result = await runtime.routing.testProfile({ workflow, modelId, reasoningLevel });
    } catch (error) {
      return { status: 409, body: { ok: false, code: error && error.code || 'PROFILE_TEST_FAILED', error: '模型切换测试失败' } };
    }
    if (result && result.auditEvent && runtime.store && typeof runtime.store.recordRouting === 'function') {
      const profile = result.profile || {};
      runtime.store.recordRouting(workflow.id, {
        summary: { enabled: true, action: 'test', reasonCode: result.code, complexityTier: profile.complexityTier, thinkingTier: profile.thinkingTier, promptPolicy: profile.promptPolicy, modelId: profile.modelId, reasoningLevel: profile.reasoningLevel, source: result.result && result.result.source, verified: result.ok === true },
        auditEvent: result.auditEvent,
      });
    }
    const response = { ok: result && result.ok === true, code: String(result && result.code || 'PROFILE_TEST_FAILED').slice(0, 80), dispatchAllowed: false, profile: result && result.profile ? { modelId: result.profile.modelId || null, reasoningLevel: result.profile.reasoningLevel || null, reasoningControl: result.profile.reasoningControl !== false } : null };
    return { status: response.ok ? 200 : 409, body: response };
  }
  const routingViewId = routeMatch(pathname, /^\/api\/orchestration\/workflows\/([^/]+)\/routing\/(overview|audit|usage|diagnostics|insights)$/);
  if (routingViewId && verb === 'GET') {
    const workflow = runtime.store.get(decodeURIComponent(routingViewId));
    if (!workflow) return { status: 404, body: { code: 'WORKFLOW_NOT_FOUND', error: 'workflow not found' } };
    const view = pathname.endsWith('/audit') ? 'audit'
      : pathname.endsWith('/usage') ? 'usage'
        : pathname.endsWith('/diagnostics') ? 'diagnostics'
          : pathname.endsWith('/insights') ? 'insights' : 'overview';
    const overview = await routingOverview(runtime, workflow);
    if (view === 'audit') return { status: 200, body: { workflowId: workflow.id, items: overview.auditTimeline } };
    if (view === 'usage') return { status: 200, body: { workflowId: workflow.id, ...overview.usage } };
    if (view === 'diagnostics') return { status: 200, body: overview.diagnostics };
    if (view === 'insights') return { status: 200, body: { workflowId: workflow.id, ...overview.insights } };
    return { status: 200, body: overview };
  }
  const receiptId = routeMatch(pathname, /^\/api\/orchestration\/workflows\/([^/]+)\/receipt$/);
  if (receiptId && verb === 'GET') {
    const workflow = runtime.store.get(decodeURIComponent(receiptId));
    if (!workflow) return { status: 404, body: { code: 'WORKFLOW_NOT_FOUND', error: 'workflow not found' } };
    return { status: 200, body: { workflowId: workflow.id, receipt: buildSafeReceipt(workflow) } };
  }
  const suggestId = routeMatch(pathname, /^\/api\/orchestration\/workflows\/([^/]+)\/suggest$/);
  if (suggestId && verb === 'POST') {
    const workflow = await runtime.suggestion.suggest(decodeURIComponent(suggestId));
    if (!workflow) return { status: 404, body: { code: 'WORKFLOW_NOT_FOUND', error: 'workflow not found' } };
    runtime.notify(workflow);
    return { status: 200, body: { ok: true, workflow, suggestion: workflow.lastSuggestion } };
  }
  const transitionId = routeMatch(pathname, /^\/api\/orchestration\/workflows\/([^/]+)\/transition$/);
  if (transitionId && verb === 'POST') {
    const workflow = transitionWorkflow({ store: runtime.store, id: decodeURIComponent(transitionId), status: body.status });
    runtime.notify(workflow);
    return { status: 200, body: { ok: true, workflow } };
  }
  const runId = routeMatch(pathname, /^\/api\/orchestration\/workflows\/([^/]+)\/run$/);
  if (runId && verb === 'POST') {
    const decodedId = decodeURIComponent(runId);
    const workflow = runtime.store.get(decodedId);
    if (!workflow) return { status: 404, body: { code: 'WORKFLOW_NOT_FOUND', error: 'workflow not found' } };
    if (workflow.autopilotMode === 'suggest') {
      return {
        status: 409,
        body: { ok: false, code: 'SUGGEST_ONLY', error: 'Suggest Mode 只生成建议，不自动执行', workflow },
      };
    }
    if (workflow.autopilotMode === 'guarded') {
      return {
        status: 409,
        body: { ok: false, code: 'GUARDED_REQUIRES_APPROVAL', error: 'Guarded Mode 需要人工批准后才能执行', workflow },
      };
    }
    if (!runtime.auto || typeof runtime.auto.run !== 'function') {
      return { status: 503, body: { ok: false, code: 'AUTO_UNAVAILABLE', error: 'Auto Loop 未就绪', workflow } };
    }
    const background = runtime.auto.run(decodedId)
      .then((result) => { runtime.notify(result); return result; })
      .catch((error) => { runtime.notify(runtime.store.get(decodedId)); return { error: error.message }; });
    return { status: 202, body: { ok: true, workflow, accepted: true }, background };
  }
  const reconcileId = routeMatch(pathname, /^\/api\/orchestration\/workflows\/([^/]+)\/reconcile$/);
  if (reconcileId && verb === 'POST') {
    if (!runtime.auto || typeof runtime.auto.reconcile !== 'function') return { status: 503, body: { code: 'AUTO_UNAVAILABLE', error: 'Auto Loop 未就绪' } };
    const workflow = await runtime.auto.reconcile(decodeURIComponent(reconcileId));
    return workflow ? { status: 200, body: { ok: true, workflow } } : { status: 404, body: { code: 'WORKFLOW_NOT_FOUND', error: 'workflow not found' } };
  }
  const evidenceId = routeMatch(pathname, /^\/api\/orchestration\/workflows\/([^/]+)\/evidence$/);
  if (evidenceId && verb === 'POST') {
    const workflow = runtime.store.recordEvidence(decodeURIComponent(evidenceId), body);
    runtime.notify(workflow);
    return { status: 200, body: { ok: true, workflow } };
  }
  const resumeId = routeMatch(pathname, /^\/api\/orchestration\/workflows\/([^/]+)\/resume$/);
  if (resumeId && verb === 'POST') {
    if (!runtime.auto || typeof runtime.auto.resume !== 'function') return { status: 503, body: { code: 'AUTO_UNAVAILABLE', error: 'Auto Loop 未就绪' } };
    const workflow = runtime.auto.resume(decodeURIComponent(resumeId), body.owner || 'human');
    return workflow ? { status: 200, body: { ok: true, workflow } } : { status: 404, body: { code: 'WORKFLOW_NOT_FOUND', error: 'workflow not found' } };
  }
  const stopId = routeMatch(pathname, /^\/api\/orchestration\/workflows\/([^/]+)\/stop$/);
  if (stopId && verb === 'POST') {
    if (!runtime.auto || typeof runtime.auto.stop !== 'function') return { status: 503, body: { code: 'AUTO_UNAVAILABLE', error: 'Auto Loop 未就绪' } };
    const workflow = runtime.auto.stop(decodeURIComponent(stopId));
    return workflow ? { status: 200, body: { ok: true, workflow } } : { status: 404, body: { code: 'WORKFLOW_NOT_FOUND', error: 'workflow not found' } };
  }
  return { status: 404, body: { code: 'ORCHESTRATION_ENDPOINT_NOT_FOUND', error: 'orchestration endpoint not found' } };
}

module.exports = { handleOrchestrationRequest };
