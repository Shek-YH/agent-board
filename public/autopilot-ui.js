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

  function createHostedSessionHandoffState({ now = () => Date.now() } = {}) {
    const pending = new Map();

    function copy(item) {
      return item ? { ...item } : null;
    }

    function add(input = {}) {
      const sessionRef = text(input.sessionRef);
      if (!sessionRef) throw new TypeError('hosted sessionRef is required');
      const previous = pending.get(sessionRef);
      const item = {
        kind: 'hosted-session-handoff',
        sessionRef,
        agent: text(input.agent).toLowerCase(),
        projectPath: text(input.projectPath),
        workflowId: text(input.workflowId),
        title: text(input.title, '新建 Session'),
        state: text(input.state, previous?.state || 'created'),
        error: text(input.error, previous?.error),
        createdAt: previous?.createdAt || now(),
        updatedAt: now(),
      };
      pending.set(sessionRef, item);
      return copy(item);
    }

    function update(sessionRef, patch = {}) {
      const key = text(sessionRef);
      const current = pending.get(key);
      if (!current) return null;
      const next = {
        ...current,
        ...patch,
        kind: current.kind,
        sessionRef: current.sessionRef,
        updatedAt: now(),
      };
      pending.set(key, next);
      return copy(next);
    }

    function get(sessionRef) {
      return copy(pending.get(text(sessionRef)));
    }

    function list() {
      return [...pending.values()].map(copy);
    }

    function listForAgent(agent) {
      const id = text(agent).toLowerCase();
      return list().filter((item) => item.agent === id);
    }

    function remove(sessionRef) {
      return pending.delete(text(sessionRef));
    }

    function reconcile(sessions) {
      const indexed = new Set((Array.isArray(sessions) ? sessions : [])
        .map((session) => text(session && (session.id || session.sessionRef)))
        .filter(Boolean));
      let removed = 0;
      for (const sessionRef of pending.keys()) {
        if (!indexed.has(sessionRef)) continue;
        pending.delete(sessionRef);
        removed++;
      }
      return removed;
    }

    return { add, update, get, list, listForAgent, remove, reconcile };
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

  function taskContractView(contract) {
    const safe = contract && typeof contract === 'object' ? contract : {};
    const classification = safe.classification && typeof safe.classification === 'object' ? safe.classification : {};
    const kind = ['direct', 'light', 'standard', 'project', 'high_risk'].includes(classification.kind)
      ? classification.kind
      : 'standard';
    const labels = {
      direct: '直接处理', light: '轻任务', standard: '标准任务',
      project: '项目任务', high_risk: '高风险任务',
    };
    const sectionDefinitions = {
      direct: [],
      light: [['dod', '完成标准'], ['evidence', '验证证据']],
      standard: [['inScope', '范围内'], ['outOfScope', '范围外'], ['dod', '完成标准'], ['evidence', '验证证据']],
      project: [['inScope', '范围内'], ['outOfScope', '范围外'], ['dod', '完成标准'], ['evidence', '验证证据'], ['risks', '风险']],
      high_risk: [['inScope', '范围内'], ['outOfScope', '范围外'], ['dod', '完成标准'], ['evidence', '验证证据'], ['risks', '风险']],
    };
    const stringList = (value) => (Array.isArray(value)
      ? value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim())
      : []);
    const source = safe.source && typeof safe.source === 'object' ? safe.source : {};
    const sourceParts = [text(source.fileName), text(source.version)].filter(Boolean);
    const humanGate = safe.humanGate && typeof safe.humanGate === 'object' ? safe.humanGate : {};
    return {
      kind,
      kindLabel: labels[kind],
      confidence: Number.isFinite(Number(classification.confidence)) ? Number(classification.confidence) : 0,
      reasons: stringList(classification.reasons),
      goal: text(safe.goal),
      sourceLabel: sourceParts.join(' · '),
      sections: sectionDefinitions[kind].map(([key, label]) => ({ key, label, items: stringList(safe[key]) })),
      humanGate: { required: humanGate.required === true, reason: text(humanGate.reason) },
      missingFields: stringList(safe.missingFields),
      inferredFields: stringList(safe.inferredFields),
    };
  }

  return { findWorkflowForSession, sessionSummary, detailForWorkflow, taskContractView, samePath, createHostedSessionHandoffState };
}));
