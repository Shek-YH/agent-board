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

function assertAllowedProject(projectPath, allowedRoots = []) {
  if (!allowedRoots.length) return;
  if (!allowedRoots.some((root) => isInsideRoot(projectPath, root))) {
    throw new Error('project outside allowed roots');
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
  autopilotMode = 'suggest',
  scope,
  verify,
  budget,
  binding,
  routingConfig,
  workerRoutingConfig,
}) {
  if (!store || typeof store.create !== 'function') throw new Error('workflow store is required');
  const request = normalizeSupervisorRequest({ projectPath, goal, mode, agent, requestedBy });
  const runContract = normalizeRunContract({
    autopilotMode,
    goal: request.goal,
    scope,
    verify,
    budget,
  });
  const classification = classifyProject(request.projectPath);
  if (classification.kind === 'invalid') throw new Error(classification.error || 'invalid project path');
  assertAllowedProject(classification.canonicalPath, allowedRoots);
  const plan = buildExecutionPlan({ classification, goal: request.goal });
  const normalizedWorkerRoutingConfig = normalizeWorkerRoutingConfig(
    workerRoutingConfig === undefined ? routingConfig : workerRoutingConfig,
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
  });
  return { workflow, classification, plan, runContract };
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
  getOrchestrationState,
  getRoutingConfig,
  routingAgentIsSupported,
  getProviderConfigState,
  transitionWorkflow,
  takeoverWorkflow,
  updateRoutingConfig,
};
