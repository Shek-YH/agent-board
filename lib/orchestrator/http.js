'use strict';

const { createWorkflowRequest, getOrchestrationState, takeoverWorkflow, transitionWorkflow } = require('./api');

function routeMatch(pathname, pattern) {
  const match = String(pathname || '').match(pattern);
  return match ? match[1] : null;
}

async function handleOrchestrationRequest({ method, pathname, query, body = {}, runtime }) {
  if (!String(pathname || '').startsWith('/api/orchestration/')) return null;
  if (!runtime) throw new Error('orchestration runtime is required');
  const verb = String(method || 'GET').toUpperCase();
  const params = query || new URLSearchParams();
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
