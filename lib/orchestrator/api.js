'use strict';

const path = require('node:path');
const { classifyProject } = require('./project-classifier');
const { buildExecutionPlan } = require('./execution-plan');
const { isInsideRoot } = require('./project-lifecycle');
const { getProviderCapabilities } = require('./provider-config');
const { normalizeSupervisorRequest } = require('./supervisor-contract');
const { normalizeRunContract } = require('./run-contract');
const { normalizeRoutingConfig } = require('./routing/runtime');

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
    routingConfig: normalizeRoutingConfig(routingConfig),
  });
  return { workflow, classification, plan, runContract };
}

function getRoutingConfig({ store, id }) {
  if (!store || typeof store.get !== 'function') throw new Error('workflow store is required');
  const workflow = store.get(String(id || ''));
  if (!workflow) return null;
  return { workflowId: workflow.id, agent: workflow.agent, supported: workflow.agent === 'codex', config: normalizeRoutingConfig(workflow.routingConfig) };
}

function updateRoutingConfig({ store, id, config }) {
  if (!store || typeof store.get !== 'function') throw new Error('workflow store is required');
  const workflow = store.get(String(id || ''));
  if (!workflow) return null;
  if (String(workflow.agent || '').toLowerCase() !== 'codex') {
    const error = new Error('Slice 3.5 routing only supports Codex');
    error.statusCode = 409;
    error.code = 'ROUTING_AGENT_UNSUPPORTED';
    throw error;
  }
  return store.updateFields(workflow.id, { routingConfig: normalizeRoutingConfig(config) }, 'routing_config_updated');
}

function getOrchestrationState({ store, env = process.env } = {}) {
  if (!store || typeof store.list !== 'function') throw new Error('workflow store is required');
  return { workflows: store.list(), capabilities: getProviderCapabilities(env) };
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
  transitionWorkflow,
  takeoverWorkflow,
  updateRoutingConfig,
};
