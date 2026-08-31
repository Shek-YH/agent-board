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
const { normalizeSettings } = require('./settings-store');
const { previewTaskIntake } = require('./task-intake');

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
  scope,
  verify,
  budget,
  binding,
  routingConfig,
  workerRoutingConfig,
  settings,
  taskContract,
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
    supervisorCostLimit: inheritedSettings.autopilot.supervisorCostLimit,
  } : undefined;
  const runContract = normalizeRunContract({
    autopilotMode: resolvedAutopilotMode,
    goal: request.goal,
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
    settingsSnapshot: inheritedSettings,
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
  const preview = await previewTaskIntake({ projectPath, goal, prdMode, prdPath, allowedRoots, env, fetchImpl });
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
  const contract = preview.taskContract;
  if (contract.classification.kind === 'direct') {
    return { ...preview, workflow: null, bypass: true, requiresApproval: false };
  }
  const verify = {
    dod: contract.dod.length ? contract.dod : ['任务目标已完成并通过验证'],
    evidence: contract.evidence.length ? contract.evidence : ['Agent Board verified execution'],
  };
  const created = createWorkflowRequest({
    projectPath: preview.session.projectPath,
    goal: contract.goal,
    mode: 'project',
    agent: preview.session.agent,
    requestedBy,
    allowedRoots,
    store,
    settings,
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
  resolveSessionContext,
  getOrchestrationState,
  getRoutingConfig,
  routingAgentIsSupported,
  getProviderConfigState,
  transitionWorkflow,
  takeoverWorkflow,
  updateRoutingConfig,
};
