'use strict';

const { createWorkflowRequest, createSessionWorkflowRequest, getOrchestrationState, getRoutingConfig, takeoverWorkflow, transitionWorkflow, updateRoutingConfig, resolveSessionContext, assertAllowedProject } = require('./api');
const { generatePrdGoalDraft } = require('./project-prd');
const {
  buildRoutingDiagnostics,
  buildRoutingTimeline,
  buildRoutingUsage,
  buildSafeReceipt,
} = require('./routing/commercial');
const { aggregateRoutingOutcomes, recommendExecutionProfile, checkRoutingWorkspace } = require('./routing/insights');

function routeMatch(pathname, pattern) {
  const match = String(pathname || '').match(pattern);
  return match ? match[1] : null;
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
  const agents = supportedRoutingAgents(runtime);
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

async function handleOrchestrationRequest({ method, pathname, query, body = {}, runtime }) {
  if (!String(pathname || '').startsWith('/api/orchestration/')) return null;
  if (!runtime) throw new Error('orchestration runtime is required');
  const verb = String(method || 'GET').toUpperCase();
  const params = query || new URLSearchParams();
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
  if (pathname === '/api/orchestration/workflows/from-session' && verb === 'POST') {
    if (!runtime.sessionStore) return { status: 503, body: { ok: false, code: 'SESSION_RESOLVER_UNAVAILABLE', error: 'Session 解析服务未就绪' } };
    try {
      const result = createSessionWorkflowRequest({
        sessionRef: body.sessionRef,
        goal: body.goal,
        sessionStore: runtime.sessionStore,
        settings: runtime.settings && typeof runtime.settings.get === 'function' ? runtime.settings.get() : undefined,
        allowedRoots: runtime.allowedRoots,
        store: runtime.store,
        requestedBy: body.requestedBy || 'human',
      });
      runtime.notify(result.workflow);
      return { status: 201, body: { ok: true, ...result } };
    } catch (error) {
      if (error && (error.code === 'SESSION_TARGET_UNRESOLVED' || error.code === 'SESSION_METADATA_UNVERIFIED')) {
        return { status: Number(error.statusCode) || 409, body: { ok: false, code: error.code, error: error.message } };
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
