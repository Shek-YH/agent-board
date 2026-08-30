'use strict';

const { createWorkflowRequest, getOrchestrationState, getRoutingConfig, takeoverWorkflow, transitionWorkflow, updateRoutingConfig } = require('./api');
const {
  buildRoutingDiagnostics,
  buildRoutingTimeline,
  buildRoutingUsage,
  buildSafeReceipt,
} = require('./routing/commercial');

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

function supportedRoutingAgents(runtime) {
  if (runtime.routing && typeof runtime.routing.supportedAgents === 'function') {
    return runtime.routing.supportedAgents();
  }
  return ['codex'];
}

async function routingOverview(runtime, workflow) {
  const catalog = await routingCatalog(runtime, workflow);
  return {
    workflowId: workflow.id,
    diagnostics: buildRoutingDiagnostics({ workflow, catalog, supportedAgents: supportedRoutingAgents(runtime) }),
    auditTimeline: buildRoutingTimeline(workflow),
    usage: buildRoutingUsage(workflow),
    receipt: buildSafeReceipt(workflow),
  };
}

async function handleOrchestrationRequest({ method, pathname, query, body = {}, runtime }) {
  if (!String(pathname || '').startsWith('/api/orchestration/')) return null;
  if (!runtime) throw new Error('orchestration runtime is required');
  const verb = String(method || 'GET').toUpperCase();
  const params = query || new URLSearchParams();
  if (pathname === '/api/orchestration/routing/catalog' && verb === 'GET') {
    const catalog = runtime.routing && typeof runtime.routing.getCatalog === 'function'
      ? await runtime.routing.getCatalog()
      : { source: 'unavailable', models: [], available: false, stale: false, reasonCode: 'CATALOG_UNAVAILABLE' };
    return {
      status: 200,
      body: {
        supportedAgents: supportedRoutingAgents(runtime),
        catalog: {
          source: catalog.source,
          available: catalog.available === true,
          stale: catalog.stale === true,
          reasonCode: catalog.reasonCode || null,
          models: Array.isArray(catalog.models) ? catalog.models : [],
        },
      },
    };
  }
  if (pathname === '/api/orchestration/state' && verb === 'GET') {
    return {
      status: 200,
      body: {
        ...getOrchestrationState({ store: runtime.store, env: runtime.env }),
        allowedRoots: runtime.allowedRoots,
        headlessEnabled: runtime.headlessEnabled,
        jarvisVoice: runtime.jarvisVoice && typeof runtime.jarvisVoice.readiness === 'function' ? runtime.jarvisVoice.readiness() : null,
      },
    };
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
    });
    runtime.notify(result.workflow);
    return { status: 201, body: { ok: true, ...result } };
  }

  const id = routeMatch(pathname, /^\/api\/orchestration\/workflows\/([^/]+)$/);
  if (id && verb === 'GET') {
    const workflow = runtime.store.get(decodeURIComponent(id));
    return workflow ? { status: 200, body: workflow } : { status: 404, body: { error: 'workflow not found' } };
  }
  const takeoverId = routeMatch(pathname, /^\/api\/orchestration\/workflows\/([^/]+)\/takeover$/);
  if (takeoverId && verb === 'POST') {
    const workflow = takeoverWorkflow({ store: runtime.store, id: decodeURIComponent(takeoverId), owner: body.owner || 'human' });
    runtime.notify(workflow);
    return { status: 200, body: { ok: true, workflow } };
  }

  const routingId = routeMatch(pathname, /^\/api\/orchestration\/workflows\/([^/]+)\/routing$/);
  if (routingId && verb === 'GET') {
    const routing = getRoutingConfig({ store: runtime.store, id: decodeURIComponent(routingId) });
    if (!routing) return { status: 404, body: { error: 'workflow not found' } };
    return { status: 200, body: { ...routing, catalog: runtime.routing && typeof runtime.routing.getCatalog === 'function' ? await runtime.routing.getCatalog() : null } };
  }
  if (routingId && verb === 'POST') {
    const workflow = updateRoutingConfig({ store: runtime.store, id: decodeURIComponent(routingId), config: body.config || body });
    if (!workflow) return { status: 404, body: { error: 'workflow not found' } };
    runtime.notify(workflow);
    return { status: 200, body: { ok: true, workflow, routing: workflow.routingConfig } };
  }
  const routingViewId = routeMatch(pathname, /^\/api\/orchestration\/workflows\/([^/]+)\/routing\/(overview|audit|usage|diagnostics)$/);
  if (routingViewId && verb === 'GET') {
    const workflow = runtime.store.get(decodeURIComponent(routingViewId));
    if (!workflow) return { status: 404, body: { error: 'workflow not found' } };
    const view = pathname.endsWith('/audit') ? 'audit'
      : pathname.endsWith('/usage') ? 'usage'
        : pathname.endsWith('/diagnostics') ? 'diagnostics' : 'overview';
    const overview = await routingOverview(runtime, workflow);
    if (view === 'audit') return { status: 200, body: { workflowId: workflow.id, items: overview.auditTimeline } };
    if (view === 'usage') return { status: 200, body: { workflowId: workflow.id, ...overview.usage } };
    if (view === 'diagnostics') return { status: 200, body: overview.diagnostics };
    return { status: 200, body: overview };
  }
  const receiptId = routeMatch(pathname, /^\/api\/orchestration\/workflows\/([^/]+)\/receipt$/);
  if (receiptId && verb === 'GET') {
    const workflow = runtime.store.get(decodeURIComponent(receiptId));
    if (!workflow) return { status: 404, body: { error: 'workflow not found' } };
    return { status: 200, body: { workflowId: workflow.id, receipt: buildSafeReceipt(workflow) } };
  }
  const suggestId = routeMatch(pathname, /^\/api\/orchestration\/workflows\/([^/]+)\/suggest$/);
  if (suggestId && verb === 'POST') {
    const workflow = await runtime.suggestion.suggest(decodeURIComponent(suggestId));
    if (!workflow) return { status: 404, body: { error: 'workflow not found' } };
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
    if (!workflow) return { status: 404, body: { error: 'workflow not found' } };
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
    if (!runtime.auto || typeof runtime.auto.reconcile !== 'function') return { status: 503, body: { error: 'Auto Loop 未就绪' } };
    const workflow = await runtime.auto.reconcile(decodeURIComponent(reconcileId));
    return workflow ? { status: 200, body: { ok: true, workflow } } : { status: 404, body: { error: 'workflow not found' } };
  }
  const evidenceId = routeMatch(pathname, /^\/api\/orchestration\/workflows\/([^/]+)\/evidence$/);
  if (evidenceId && verb === 'POST') {
    const workflow = runtime.store.recordEvidence(decodeURIComponent(evidenceId), body);
    runtime.notify(workflow);
    return { status: 200, body: { ok: true, workflow } };
  }
  const resumeId = routeMatch(pathname, /^\/api\/orchestration\/workflows\/([^/]+)\/resume$/);
  if (resumeId && verb === 'POST') {
    if (!runtime.auto || typeof runtime.auto.resume !== 'function') return { status: 503, body: { error: 'Auto Loop 未就绪' } };
    const workflow = runtime.auto.resume(decodeURIComponent(resumeId), body.owner || 'human');
    return workflow ? { status: 200, body: { ok: true, workflow } } : { status: 404, body: { error: 'workflow not found' } };
  }
  const stopId = routeMatch(pathname, /^\/api\/orchestration\/workflows\/([^/]+)\/stop$/);
  if (stopId && verb === 'POST') {
    if (!runtime.auto || typeof runtime.auto.stop !== 'function') return { status: 503, body: { error: 'Auto Loop 未就绪' } };
    const workflow = runtime.auto.stop(decodeURIComponent(stopId));
    return workflow ? { status: 200, body: { ok: true, workflow } } : { status: 404, body: { error: 'workflow not found' } };
  }
  return { status: 404, body: { error: 'orchestration endpoint not found' } };
}

module.exports = { handleOrchestrationRequest };
