(function attachAutoPilotUi(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AgentBoardAutoPilotUi = api;
}(typeof window === 'object' ? window : globalThis, function createAutoPilotUi() {
  function text(value, fallback = '') {
    return typeof value === 'string' && value.trim() ? value.trim() : fallback;
  }

  function samePath(left, right) {
    const normalize = (value) => text(value).replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase();
    return normalize(left) === normalize(right);
  }

  function findWorkflowForSession(workflows, session) {
    const list = Array.isArray(workflows) ? workflows : [];
    const sessionRef = text(session && (session.id || session.sessionRef));
    const agent = text(session && session.agent).toLowerCase();
    const project = text(session && session.project);
    if (!sessionRef) return null;
    return list.find((workflow) => {
      const binding = workflow && workflow.binding;
      return workflow && workflow.autopilotMode === 'auto' && binding
        && text(binding.sessionRef) === sessionRef
        && (!agent || text(workflow.agent).toLowerCase() === agent)
        && (!project || !binding.projectPath || samePath(binding.projectPath, project));
    }) || null;
  }

  function sessionSummary(workflow) {
    if (!workflow) return { kind: 'setup', label: '配置 AutoPilot', title: '为此 Session 配置 AutoPilot' };
    const state = text(workflow.autoState, 'OFF');
    const round = Number.isInteger(workflow.runCount) ? workflow.runCount : 0;
    const labels = {
      OFF: '未启动', PREFLIGHT: '准备中', WAITING_AGENT: '等待 Agent', REVIEWING: '监督复核',
      DISPATCHING: '发送中', VERIFYING: '验收送达', PAUSED: '已暂停', BLOCKED: '已阻塞',
      DONE: '已完成', STOPPED: '已停止',
    };
    return {
      kind: state === 'DONE' ? 'done' : ['PAUSED', 'BLOCKED', 'STOPPED'].includes(state) ? 'paused' : 'running',
      label: `AI 托管 · 第 ${round} 轮`,
      title: `AutoPilot：${labels[state] || state} · 第 ${round} 轮`,
      state,
    };
  }

  function detailForWorkflow(workflow, latestDispatch = null) {
    const contract = workflow && workflow.runContract || {};
    const scope = contract.scope || {};
    const progress = workflow && workflow.progress || {};
    const route = workflow && workflow.lastRouting || {};
    const accepted = workflow && workflow.acceptedTurnSnapshot || {};
    const profile = accepted.resolvedProfile || {};
    const evidence = Array.isArray(progress.evidence) ? progress.evidence : [];
    const byIndex = new Map(evidence.map((item) => [item.dodIndex, item]));
    const dod = Array.isArray(contract.verify?.dod) ? contract.verify.dod : [];
    return {
      goal: text(contract.goal, '未声明'),
      scope: [...(scope.inScope || []), ...(scope.outOfScope || []).map((item) => `范围外：${item}`)],
      dod: dod.map((item, index) => ({ description: item, passed: byIndex.get(index)?.passed === true })),
      progress: { completed: Number(progress.completed || 0), total: Number(progress.total || dod.length), percent: Number(progress.percent || 0) },
      currentModel: text(route.modelId, text(profile.modelId, '未应用')),
      reasoning: text(route.reasoningLevel, text(profile.reasoningLevel, '未应用')),
      routeReason: text(route.reasonCode, '当前配置'),
      lastDecision: text(workflow.lastDecision?.summary, text(workflow.lastDecision?.decision, '尚无监督决策')),
      deliveryState: text(latestDispatch?.state, text(workflow.autoState, '未开始')),
    };
  }

  return { findWorkflowForSession, sessionSummary, detailForWorkflow, samePath };
}));
