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
    const supervisorReview = workflow && workflow.lastDecision && workflow.lastDecision.review;
    const evidenceSnapshot = workflow && workflow.lastEvidence && typeof workflow.lastEvidence === 'object' ? workflow.lastEvidence : {};
    const evidence = Array.isArray(progress.evidence) ? progress.evidence : [];
    const byIndex = new Map(evidence.map((item) => [item.dodIndex, item]));
    const dod = Array.isArray(contract.verify?.dod) ? contract.verify.dod : [];
    const handoffChain = Array.isArray(workflow?.handoffChain) ? workflow.handoffChain : [];
    const currentStep = handoffChain.find((step) => step && step.status !== 'done') || null;
    const completedSteps = handoffChain.filter((step) => step && step.status === 'done').length;
    const research = workflow && (workflow.researchState || workflow.taskContract?.research);
    const hosted = workflow && workflow.hostedControl;
    const detail = {
      goal: text(contract.goal, '未声明'),
      scope: [...(scope.inScope || []), ...(scope.outOfScope || []).map((item) => `范围外：${item}`)],
      dod: dod.map((item, index) => ({ description: item, passed: byIndex.get(index)?.passed === true })),
      progress: { completed: Number(progress.completed || 0), total: Number(progress.total || dod.length), percent: Number(progress.percent || 0) },
      currentModel: text(route.modelId, text(profile.modelId, '未应用')),
      reasoning: text(route.reasoningLevel, text(profile.reasoningLevel, '未应用')),
      routeReason: text(route.reasonCode, '当前配置'),
      lastDecision: text(workflow.lastDecision?.summary, text(workflow.lastDecision?.decision, '尚无监督决策')),
      supervisorReview: supervisorReview ? {
        source: text(supervisorReview.source, 'deterministic'),
        decision: text(supervisorReview.decision, 'UNKNOWN'),
        summary: text(supervisorReview.summary, '未提供复核说明'),
      } : null,
      evidence: {
        checks: Array.isArray(evidenceSnapshot.checks) ? evidenceSnapshot.checks.slice(0, 12).map((item) => ({
          operation: text(item && item.operation, 'check'), status: text(item && item.status, 'unknown'),
        })) : [],
        skipped: Array.isArray(evidenceSnapshot.skipped) ? evidenceSnapshot.skipped.length : 0,
      },
      handoffProgress: {
        completed: completedSteps, total: handoffChain.length,
        percent: handoffChain.length ? Math.round((completedSteps / handoffChain.length) * 100) : 0,
      },
      currentStep: currentStep ? {
        id: text(currentStep.id), order: Number.isInteger(currentStep.order) ? currentStep.order : 0,
        agent: text(currentStep.agent), status: text(currentStep.status, 'pending'),
      } : null,
      blockReason: text(workflow?.lastError, text(workflow?.stopReason, text(currentStep?.result?.reason))),
      needHumanReason: text(currentStep?.result?.reason),
      deliveryState: text(latestDispatch?.state, text(workflow.autoState, '未开始')),
    };
    if (research && typeof research === 'object') {
      detail.research = {
        status: text(research.status, 'not_started'),
        confidence: Number.isFinite(Number(research.confidence)) ? Number(research.confidence) : 0,
        confidenceLevel: text(research.confidenceLevel, 'low'),
        errorCode: text(research.errorCode),
        unresolvedQuestions: Array.isArray(research.unresolvedQuestions) ? research.unresolvedQuestions.filter((item) => typeof item === 'string').slice(0, 12) : [],
      };
    }
    if (currentStep?.researchState) {
      detail.currentStep.research = {
        status: text(currentStep.researchState.status, 'not_started'),
        confidence: Number.isFinite(Number(currentStep.researchState.confidence)) ? Number(currentStep.researchState.confidence) : 0,
      };
    }
    if (hosted && hosted.enabled === true) {
      detail.hostedControl = {
        enabled: true,
        sourceTaskId: text(hosted.sourceTaskId),
        targetTaskId: text(hosted.targetTaskId),
        hostId: text(hosted.hostId),
        round: Number.isInteger(hosted.round) ? hosted.round : 0,
        lastAgentMessageStatus: text(hosted.lastAgentMessageStatus, 'unknown'),
        blockedReason: text(hosted.blockedReason),
      };
    }
    return detail;
  }

  function taskContractView(contract, options = {}) {
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
      direct: options.complete === true ? [['inScope', '范围内'], ['outOfScope', '范围外'], ['dod', '完成标准'], ['evidence', '验证证据']] : [],
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
    const research = safe.research && typeof safe.research === 'object' ? safe.research : {};
    const complexityLabels = { simple: '简单', standard: '标准', complex: '复杂' };
    const riskLabels = { low: '低风险', medium: '中风险', high: '高风险', critical: '极高风险' };
    const sourceLabels = {
      'goal-only': '仅根据任务目标', 'prd+safety': 'PRD + 默认安全策略',
      'goal+prd+safety': '任务目标 + PRD + 默认安全策略',
    };
    const missingFields = stringList(safe.missingFields);
    const missingFieldLabels = stringList(safe.missingFieldLabels).length
      ? stringList(safe.missingFieldLabels) : missingFields.map((field) => ({
        goal: '任务目标', inScope: '范围内', outOfScope: '范围外', dod: '完成标准（DoD）', evidence: '验证证据',
      }[field] || field));
    return {
      kind,
      kindLabel: labels[kind],
      confidence: Number.isFinite(Number(safe.confidence)) ? Number(safe.confidence) : (Number.isFinite(Number(classification.confidence)) ? Number(classification.confidence) : 0),
      confidenceLevel: text(safe.confidenceLevel, 'low'),
      generationStatus: text(safe.generationStatus, 'draft'),
      complexity: ['simple', 'standard', 'complex'].includes(classification.complexity) ? classification.complexity : 'standard',
      complexityLabel: complexityLabels[classification.complexity] || '标准',
      riskLevel: ['low', 'medium', 'high', 'critical'].includes(classification.riskLevel) ? classification.riskLevel : 'low',
      riskLabel: riskLabels[classification.riskLevel] || '低风险',
      riskReasons: stringList(classification.riskReasons),
      reasons: stringList(classification.reasons),
      goal: text(safe.goal),
      sourceLabel: sourceParts.join(' · ') || sourceLabels[text(safe.sourceSummary)] || text(safe.sourceSummary),
      sourceSummary: sourceLabels[text(safe.sourceSummary)] || text(safe.sourceSummary) || '仅根据任务目标',
      sections: sectionDefinitions[kind].map(([key, label]) => ({ key, label, items: stringList(safe[key]) })),
      assumptions: stringList(safe.assumptions),
      requiredPermissions: stringList(safe.requiredPermissions),
      allowedOperations: stringList(safe.allowedOperations),
      blockedOperations: stringList(safe.blockedOperations),
      generationSources: safe.generationSources && typeof safe.generationSources === 'object' ? { ...safe.generationSources } : {},
      humanGate: { required: humanGate.required === true, reason: text(humanGate.reason) },
      needsHumanReason: text(safe.needsHumanReason),
      research: {
        status: text(research.status, 'not_started'),
        confidence: Number.isFinite(Number(research.confidence)) ? Number(research.confidence) : 0,
        confidenceLevel: text(research.confidenceLevel, 'low'),
        unresolvedQuestions: stringList(research.unresolvedQuestions),
        sources: Array.isArray(research.sources) ? research.sources.slice(0, 8).map((item) => ({
          kind: text(item && item.kind), title: text(item && (item.title || item.name)), path: text(item && item.path), url: text(item && item.url),
        })) : [],
      },
      researchableFields: stringList(safe.researchableFields),
      humanRequiredFields: stringList(safe.humanRequiredFields),
      missingFields,
      missingFieldLabels,
      inferredFields: stringList(safe.inferredFields),
    };
  }

  return { findWorkflowForSession, sessionSummary, detailForWorkflow, taskContractView, samePath, createHostedSessionHandoffState };
}));
