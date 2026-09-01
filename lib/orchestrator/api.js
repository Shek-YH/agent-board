'use strict';

const path = require('node:path');
const { classifyProject } = require('./project-classifier');
const { buildExecutionPlan } = require('./execution-plan');
const { isInsideRoot } = require('./project-lifecycle');
const {
  getProviderCapabilities,
  getProviderConfigState,
  normalizeWorkerRoutingConfig,
} = require('./provider-config');
const { normalizeSupervisorRequest } = require('./supervisor-contract');
const { normalizeRunContract } = require('./run-contract');
const { createSettingsSnapshot, normalizeSettings } = require('./settings-store');
const { buildPermissionSnapshot } = require('./permission-snapshot');
const { provisionSession } = require('./session-provisioner');
const { validateProjectContext } = require('./project-context');
const { autoCompleteTaskContract, normalizeTaskContract, previewTaskIntake, validateTaskContract } = require('./task-intake');

function assertAllowedProject(projectPath, allowedRoots = []) {
  if (!allowedRoots.length) return;
  if (!allowedRoots.some((root) => isInsideRoot(projectPath, root))) {
    const error = new Error('project outside allowed roots');
    error.code = 'PROJECT_OUTSIDE_ALLOWED_ROOTS';
    error.statusCode = 403;
    throw error;
  }
}

function createWorkflowRequest({
  projectPath,
  goal,
  mode = 'project',
  agent = '',
  requestedBy = 'human',
  allowedRoots = [],
  store,
  autopilotMode,
  goalSummary,
  scope,
  verify,
  budget,
  binding,
  routingConfig,
  workerRoutingConfig,
  settings,
  settingsSnapshot,
  taskContract,
  permissionSnapshot,
}) {
  if (!store || typeof store.create !== 'function') throw new Error('workflow store is required');
  const request = normalizeSupervisorRequest({ projectPath, goal, mode, agent, requestedBy });
  const inheritedSettings = settings === undefined ? null : normalizeSettings(settings);
  const resolvedAutopilotMode = autopilotMode === undefined
    ? (inheritedSettings ? inheritedSettings.autopilot.defaultMode : 'suggest')
    : autopilotMode;
  const inheritedBudget = inheritedSettings ? {
    maxIterations: inheritedSettings.autopilot.maxIterations,
    maxRuntime: inheritedSettings.autopilot.maxRuntimeMs,
    maxBudget: inheritedSettings.autopilot.maxBudget,
    stagnationThreshold: inheritedSettings.autopilot.stagnationThreshold,
    failureThreshold: inheritedSettings.autopilot.failureThreshold,
    supervisorCostLimit: inheritedSettings.autopilot.supervisorCostLimit,
  } : undefined;
  const runContract = normalizeRunContract({
    autopilotMode: resolvedAutopilotMode,
    goal: request.goal,
    goalSummary,
    scope,
    verify,
    budget: budget === undefined ? inheritedBudget : { ...inheritedBudget, ...budget },
  });
  const classification = classifyProject(request.projectPath);
  if (classification.kind === 'invalid') throw new Error(classification.error || 'invalid project path');
  assertAllowedProject(classification.canonicalPath, allowedRoots);
  const plan = buildExecutionPlan({ classification, goal: request.goal });
  const requestedRoutingConfig = workerRoutingConfig === undefined ? routingConfig : workerRoutingConfig;
  const normalizedWorkerRoutingConfig = normalizeWorkerRoutingConfig(
    requestedRoutingConfig === undefined && inheritedSettings ? inheritedSettings.routing : requestedRoutingConfig,
  );
  const workflow = store.create({
    projectPath: plan.projectPath,
    mode: request.mode,
    agent: request.agent,
    classification,
    executionPlan: plan,
    requestedBy: request.requestedBy,
    autopilotMode: runContract.autopilotMode,
    runContract,
    binding,
    routingConfig: normalizedWorkerRoutingConfig,
    settingsSnapshot: settingsSnapshot || (inheritedSettings ? createSettingsSnapshot(inheritedSettings) : null),
    permissionSnapshot: permissionSnapshot || (inheritedSettings ? buildPermissionSnapshot({ projectPath: plan.projectPath, settings: inheritedSettings }) : null),
    taskContract,
  });
  return { workflow, classification, plan, runContract };
}

async function previewSessionTaskIntake({
  sessionRef,
  goal,
  prdMode,
  prdPath,
  sessionStore,
  allowedRoots = [],
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  const { ref, session, projectPath, agent } = resolveSessionContext({ sessionRef, sessionStore });
  assertAllowedProject(projectPath, allowedRoots);
  const requestedGoal = String(goal || '').trim();
  const runtimeContext = { projectPathSource: 'session', agentSource: 'session', sessionRefSource: 'session' };
  let preview;
  try {
    preview = await previewTaskIntake({ projectPath, goal: requestedGoal, prdMode, prdPath, allowedRoots, env, fetchImpl, runtimeContext });
  } catch (error) {
    const fallbackGoal = String(session.last_user_text || session.lastUserText || session.title || '').trim();
    if (requestedGoal || error.code !== 'TASK_GOAL_REQUIRED' || !fallbackGoal) throw error;
    preview = await previewTaskIntake({ projectPath, goal: fallbackGoal, prdMode, prdPath, allowedRoots, env, fetchImpl, runtimeContext });
  }
  return {
    ...preview,
    session: {
      sessionRef: ref,
      agent,
      projectPath,
      title: typeof session.title === 'string' ? session.title.slice(0, 300) : '',
    },
  };
}

function normalizedProjectPath(value) {
  return path.resolve(String(value || '').trim()).replace(/[\\/]+$/, '').toLowerCase();
}

function duplicateSessions({ sessionStore, agent, projectPath } = {}) {
  if (!sessionStore || typeof sessionStore.getSessions !== 'function') return [];
  const expectedAgent = String(agent || '').trim().toLowerCase();
  const expectedPath = normalizedProjectPath(projectPath);
  return sessionStore.getSessions({ agent: expectedAgent, limit: 1_000 })
    .filter((item) => String(item.agent || '').trim().toLowerCase() === expectedAgent
      && normalizedProjectPath(item.project || item.cwd) === expectedPath)
    .map((item) => ({
      sessionRef: String(item.id || item.sessionRef || '').trim(),
      agent: expectedAgent,
      projectPath,
      title: String(item.title || '').trim().slice(0, 300),
      lastSeen: Number.isFinite(item.last_seen) ? item.last_seen : (Number.isFinite(item.lastActivity) ? item.lastActivity : 0),
      sessionRole: item.session_role || item.role || 'unknown',
      controlEligibility: item.control_eligibility || item.controlEligibility || 'unknown',
    }))
    .filter((item) => item.sessionRef);
}

function taskContractValidationError(validation) {
  const error = new Error('Task Contract 尚未完成');
  error.code = 'TASK_CONTRACT_INCOMPLETE';
  error.statusCode = 422;
  error.missingFields = validation.missingFields;
  error.missingFieldLabels = validation.missingFieldLabels;
  error.reasons = validation.reasons;
  error.suggestedActions = validation.suggestedActions;
  error.permissionViolations = validation.permissionViolations;
  return error;
}

function applyValidationHumanGate(contract, validation) {
  if (!validation.needsHuman && !validation.permissionViolations.length && contract.humanGate.required) return contract;
  if (!validation.needsHuman && !validation.permissionViolations.length) return contract;
  const reason = validation.permissionViolations.length
    ? `以下权限未在预授权范围内，已暂停等待人工处理：${validation.permissionViolations.join('、')}`
    : contract.needsHumanReason || contract.humanGate.reason || '当前任务需要人工确认后再执行。';
  return normalizeTaskContract({
    ...contract,
    needsHumanReason: reason,
    humanGate: { ...contract.humanGate, required: true, state: 'NEED_HUMAN', reason },
  });
}

async function previewProjectTaskIntake({
  agent, projectPath, goal, prdMode, prdPath, sessionStore, allowedRoots = [], env = process.env, fetchImpl = globalThis.fetch,
} = {}) {
  const context = validateProjectContext({ projectPath, allowedRoots });
  const id = String(agent || '').trim().toLowerCase();
  if (!id) {
    const error = new TypeError('Agent is required');
    error.code = 'AGENT_REQUIRED';
    error.statusCode = 400;
    throw error;
  }
  const preview = await previewTaskIntake({
    projectPath: context.projectPath, goal, prdMode, prdPath, allowedRoots, env, fetchImpl,
    runtimeContext: { projectPathSource: 'project', agentSource: 'client', sessionRefSource: 'none' },
  });
  return {
    ...preview,
    projectContext: context,
    agent: id,
    session: null,
    existingSessions: duplicateSessions({ sessionStore, agent: id, projectPath: context.projectPath }),
  };
}

async function createConfirmedTask({
  draft,
  taskContract,
  sessionChoice = 'new',
  sessionRef = '',
  sessionStore,
  sessionProvisioners,
  settings,
  allowedRoots = [],
  store,
  requestedBy = 'human',
} = {}) {
  if (!draft || typeof draft !== 'object') {
    const error = new Error('Task Contract 草稿不存在或已过期');
    error.code = 'TASK_DRAFT_NOT_FOUND';
    error.statusCode = 409;
    throw error;
  }
  const context = validateProjectContext({ projectPath: draft.projectPath, allowedRoots });
  let contract = autoCompleteTaskContract({ contract: taskContract || draft.taskContract, fallback: draft.taskContract });
  const currentSettings = normalizeSettings(settings || {});
  const confirmedSettingsSnapshot = createSettingsSnapshot(currentSettings);
  const confirmedPermissionSnapshot = buildPermissionSnapshot({ projectPath: context.projectPath, settings: currentSettings });
  const validation = validateTaskContract({ contract, permissionSnapshot: confirmedPermissionSnapshot });
  if (!contract.goal) {
    throw taskContractValidationError(validation);
  }
  contract = applyValidationHumanGate(contract, validation);
  const duplicates = duplicateSessions({ sessionStore, agent: draft.agent, projectPath: context.projectPath });
  const choice = sessionChoice === 'continue' ? 'continue' : 'new';
  let session;
  if (choice === 'continue') {
    const requested = String(sessionRef || '').trim();
    const candidate = duplicates.find((item) => item.sessionRef === requested) || (requested ? null : duplicates[0]);
    if (!candidate) {
      const error = new Error('没有可继续的同项目 Session，请选择创建新 Session');
      error.code = 'DUPLICATE_SESSION_NOT_FOUND';
      error.statusCode = 409;
      throw error;
    }
    const resolved = resolveSessionContext({ sessionRef: candidate.sessionRef, sessionStore });
    if (resolved.agent !== draft.agent || normalizedProjectPath(resolved.projectPath) !== normalizedProjectPath(context.projectPath)
      || (resolved.session.session_role && resolved.session.session_role !== 'main')
      || (resolved.session.control_eligibility && resolved.session.control_eligibility !== 'eligible')) {
      const error = new Error('已有 Session 的身份或项目绑定无法重新验证');
      error.code = 'SESSION_METADATA_UNVERIFIED';
      error.statusCode = 409;
      throw error;
    }
    session = { sessionRef: resolved.ref, agent: resolved.agent, projectPath: context.projectPath, title: resolved.session.title || '' };
  } else {
    session = await provisionSession({
      agent: draft.agent, projectPath: context.projectPath, title: contract.goal, provisioners: sessionProvisioners,
    });
  }

  if (contract.classification.kind === 'direct') {
    return {
      taskContract: contract, projectContext: context, session, workflow: null, bypass: true, requiresApproval: false,
      sessionChoice: choice, settingsSnapshot: confirmedSettingsSnapshot, permissionSnapshot: confirmedPermissionSnapshot,
    };
  }
  const verify = {
    dod: contract.dod.length ? contract.dod : ['任务目标已完成并通过验证'],
    evidence: contract.evidence.length ? contract.evidence : ['Agent Board verified execution'],
  };
  const selectedModel = currentSettings.autopilot.defaultModel === 'auto' ? null : currentSettings.autopilot.defaultModel;
  const selectedReasoning = currentSettings.autopilot.defaultReasoning === 'auto' ? null : currentSettings.autopilot.defaultReasoning;
  const routingConfig = {
    ...currentSettings.routing,
    enabled: currentSettings.routing.enabled === true || Boolean(selectedModel || selectedReasoning),
    preset: currentSettings.routing.preset || currentSettings.autopilot.routingPreset,
    ...(selectedModel || selectedReasoning ? {
      manualPin: { modelId: selectedModel, reasoningLevel: selectedReasoning },
      respectManualPin: true,
    } : {}),
  };
  const created = createWorkflowRequest({
    projectPath: context.projectPath, goal: contract.goal, goalSummary: contract.goalSummary, mode: 'project', agent: draft.agent, requestedBy,
    allowedRoots, store, settings: currentSettings, routingConfig,
    binding: {
      sessionRef: session.sessionRef, agent: draft.agent, projectPath: context.projectPath,
      ...(session.title ? { title: session.title } : {}),
      ...(session.transport ? { transport: session.transport } : {}),
    },
    autopilotMode: currentSettings.autopilot.defaultMode,
    scope: { inScope: contract.inScope, outOfScope: contract.outOfScope }, verify, taskContract: contract,
    settingsSnapshot: confirmedSettingsSnapshot,
    permissionSnapshot: confirmedPermissionSnapshot,
  });
  if (contract.humanGate.required) {
    store.transition(created.workflow.id, 'paused');
    created.workflow = store.updateFields(created.workflow.id, { stopReason: contract.humanGate.reason }, 'human_gate_required');
  }
  return {
    ...created, taskContract: contract, projectContext: context, session, bypass: false,
    requiresApproval: contract.humanGate.required, existingSessions: duplicates, sessionChoice: choice,
  };
}

async function createSessionIntakeWorkflowRequest({
  sessionRef,
  goal,
  prdMode,
  prdPath,
  sessionStore,
  settings,
  allowedRoots = [],
  store,
  requestedBy = 'human',
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  const preview = await previewSessionTaskIntake({
    sessionRef, goal, prdMode, prdPath, sessionStore, allowedRoots, env, fetchImpl,
  });
  let contract = autoCompleteTaskContract({ contract: preview.taskContract, fallback: preview.taskContract });
  if (contract.classification.kind === 'direct') {
    return { ...preview, workflow: null, bypass: true, requiresApproval: false };
  }
  const currentSettings = normalizeSettings(settings || {});
  const settingsSnapshot = createSettingsSnapshot(currentSettings);
  const permissionSnapshot = buildPermissionSnapshot({ projectPath: preview.session.projectPath, settings: currentSettings });
  const validation = validateTaskContract({ contract, permissionSnapshot });
  if (!contract.goal) throw taskContractValidationError(validation);
  contract = applyValidationHumanGate(contract, validation);
  const verify = {
    dod: contract.dod.length ? contract.dod : ['任务目标已完成并通过验证'],
    evidence: contract.evidence.length ? contract.evidence : ['Agent Board verified execution'],
  };
  const created = createWorkflowRequest({
    projectPath: preview.session.projectPath,
    goal: contract.goal,
    goalSummary: contract.goalSummary,
    mode: 'project',
    agent: preview.session.agent,
    requestedBy,
    allowedRoots,
    store,
    settings: currentSettings,
    settingsSnapshot,
    permissionSnapshot,
    binding: {
      sessionRef: preview.session.sessionRef,
      agent: preview.session.agent,
      projectPath: preview.session.projectPath,
      ...(preview.session.title ? { title: preview.session.title } : {}),
    },
    scope: { inScope: contract.inScope, outOfScope: contract.outOfScope },
    verify,
    taskContract: contract,
  });
  if (contract.humanGate.required) {
    store.transition(created.workflow.id, 'paused');
    created.workflow = store.updateFields(created.workflow.id, {
      stopReason: contract.humanGate.reason,
    }, 'human_gate_required');
  }
  return {
    ...preview,
    ...created,
    workflow: created.workflow,
    bypass: false,
    requiresApproval: contract.humanGate.required,
  };
}

function resolveSessionContext({ sessionRef, sessionStore } = {}) {
  const ref = typeof sessionRef === 'string' ? sessionRef.trim() : '';
  if (!ref || ref.length > 500) throw new TypeError('sessionRef must be a non-empty string');
  if (!sessionStore || typeof sessionStore.resolveSessionControlTarget !== 'function'
    || typeof sessionStore.getSession !== 'function') throw new Error('session resolver is required');
  const resolution = sessionStore.resolveSessionControlTarget({ sessionRef: ref });
  if (!resolution || resolution.status !== 'resolved' || !resolution.target || resolution.target.sessionRef !== ref) {
    const error = new Error(resolution && resolution.reason || '无法唯一定位当前 Session');
    error.statusCode = 409;
    error.code = 'SESSION_TARGET_UNRESOLVED';
    throw error;
  }
  const session = sessionStore.getSession(ref);
  const projectPath = session && String(session.project || session.cwd || '').trim();
  const agent = session && String(session.agent || '').trim().toLowerCase();
  if (!projectPath || !agent) {
    const error = new Error('当前 Session 缺少可验证的 Agent 或项目路径');
    error.statusCode = 409;
    error.code = 'SESSION_METADATA_UNVERIFIED';
    throw error;
  }
  return { ref, session, projectPath, agent };
}

function createSessionWorkflowRequest({
  sessionRef,
  goal,
  title,
  sessionStore,
  settings,
  allowedRoots = [],
  store,
  requestedBy = 'human',
} = {}) {
  const { ref, session, projectPath, agent } = resolveSessionContext({ sessionRef, sessionStore });
  const result = createWorkflowRequest({
    projectPath,
    goal,
    mode: 'project',
    agent,
    requestedBy,
    allowedRoots,
    store,
    settings,
    binding: {
      sessionRef: ref, agent, projectPath,
      ...(String(title || session.title || '').trim() ? { title: String(title || session.title).trim().slice(0, 300) } : {}),
    },
    verify: { dod: ['任务目标已完成并通过验证'], evidence: ['Agent Board verified execution'] },
  });
  return {
    ...result,
    session: {
      sessionRef: ref,
      agent,
      projectPath,
      title: typeof session.title === 'string' ? session.title.slice(0, 300) : '',
    },
  };
}

function routingAgentIsSupported(agent, supportedAgents = ['codex']) {
  const supported = Array.isArray(supportedAgents) ? supportedAgents.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean) : ['codex'];
  return supported.includes(String(agent || '').trim().toLowerCase());
}

function getRoutingConfig({ store, id, supportedAgents = ['codex'] }) {
  if (!store || typeof store.get !== 'function') throw new Error('workflow store is required');
  const workflow = store.get(String(id || ''));
  if (!workflow) return null;
  return {
    workflowId: workflow.id,
    agent: workflow.agent,
    supported: routingAgentIsSupported(workflow.agent, supportedAgents),
    config: normalizeWorkerRoutingConfig(workflow.routingConfig),
  };
}

function updateRoutingConfig({ store, id, config, supportedAgents = ['codex'] }) {
  if (!store || typeof store.get !== 'function') throw new Error('workflow store is required');
  const workflow = store.get(String(id || ''));
  if (!workflow) return null;
  if (!routingAgentIsSupported(workflow.agent, supportedAgents)) {
    const error = new Error('当前 Agent 不支持 Model Routing');
    error.statusCode = 409;
    error.code = 'ROUTING_AGENT_UNSUPPORTED';
    throw error;
  }
  return store.updateFields(workflow.id, { routingConfig: normalizeWorkerRoutingConfig(config) }, 'routing_config_updated');
}

function getOrchestrationState({ store, env = process.env, supervisorConfig, workerRoutingConfig } = {}) {
  if (!store || typeof store.list !== 'function') throw new Error('workflow store is required');
  return {
    workflows: store.list(),
    capabilities: getProviderCapabilities(env),
    providerConfig: getProviderConfigState({ env, supervisorConfig, workerRoutingConfig }),
  };
}

function transitionWorkflow({ store, id, status }) {
  if (!id || !status) throw new Error('workflow id and status are required');
  return store.transition(String(id), String(status));
}

function takeoverWorkflow({ store, id, owner = 'human' }) {
  if (!id) throw new Error('workflow id is required');
  return store.takeover(String(id), owner);
}

module.exports = {
  assertAllowedProject,
  createWorkflowRequest,
  createSessionWorkflowRequest,
  createSessionIntakeWorkflowRequest,
  previewSessionTaskIntake,
  previewProjectTaskIntake,
  createConfirmedTask,
  duplicateSessions,
  resolveSessionContext,
  getOrchestrationState,
  getRoutingConfig,
  routingAgentIsSupported,
  getProviderConfigState,
  transitionWorkflow,
  takeoverWorkflow,
  updateRoutingConfig,
};
