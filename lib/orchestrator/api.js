'use strict';

const path = require('node:path');
const { classifyProject } = require('./project-classifier');
const { buildExecutionPlan } = require('./execution-plan');
const { isInsideRoot } = require('./project-lifecycle');
const { getProviderCapabilities } = require('./provider-config');
const { normalizeSupervisorRequest } = require('./supervisor-contract');

function assertAllowedProject(projectPath, allowedRoots = []) {
  if (!allowedRoots.length) return;
  if (!allowedRoots.some((root) => isInsideRoot(projectPath, root))) {
    throw new Error('project outside allowed roots');
  }
}

function createWorkflowRequest({ projectPath, goal, mode = 'project', agent = '', requestedBy = 'human', allowedRoots = [], store }) {
  if (!store || typeof store.create !== 'function') throw new Error('workflow store is required');
  const request = normalizeSupervisorRequest({ projectPath, goal, mode, agent, requestedBy });
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
  });
  return { workflow, classification, plan };
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
  transitionWorkflow,
  takeoverWorkflow,
};
