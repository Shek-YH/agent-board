'use strict';

const os = require('node:os');
const path = require('node:path');
const { WorkflowStore } = require('./workflow-store');
const { WorkflowRunner } = require('./runner');
const { createSuggestionService } = require('./suggestion-engine');
const { AutoLoop } = require('./auto-loop');
const { HeadlessTransport } = require('./transport');
const { createRoutingRuntime } = require('./routing/runtime');

function parseAllowedRoots(value = '') {
  return String(value || '')
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => path.resolve(item));
}

function defaultWorkflowPath() {
  return path.join(os.homedir(), 'AppData', 'Local', 'AgentBoard', 'workflows.json');
}

function createOrchestrationRuntime({
  env = process.env, filePath = defaultWorkflowPath(), runCommand, onWorkflowChange, workbuddyCliPath, nodeExecutable,
  verifiedDispatchDependencies, autoDispatch, autoNow, routingNativeCapability, routingProfileFallback,
  routingCachePath, routingAgentVersion,
} = {}) {
  const store = new WorkflowStore(filePath);
  const allowedRoots = parseAllowedRoots(env.AGENT_BOARD_ALLOWED_ROOTS);
  const transport = new HeadlessTransport({
    enabled: env.AGENT_BOARD_HEADLESS_EXECUTION === '1', workbuddyCliPath, nodeExecutable,
  });
  const runner = new WorkflowRunner({ store, transport, allowedRoots, runCommand });
  const suggestion = createSuggestionService({ store });
  const notify = (workflow) => {
    if (typeof onWorkflowChange === 'function') onWorkflowChange(workflow);
  };
  const routing = createRoutingRuntime({
    nativeCapability: routingNativeCapability,
    profileFallback: routingProfileFallback,
    cachePath: routingCachePath,
    agentVersion: routingAgentVersion,
  });
  const auto = new AutoLoop({
    store, allowedRoots, resolveDependencies: verifiedDispatchDependencies,
    dispatch: autoDispatch, routingRuntime: routing, now: autoNow || (() => Date.now()), onWorkflowChange: notify,
  });
  auto.reconcileAll().catch(() => {});
  auto.startPeriodicReconciliation(Number(env.AGENT_BOARD_AUTOPILOT_RECONCILE_MS) || 60_000);
  return { store, runner, auto, routing, suggestion, transport, allowedRoots, headlessEnabled: transport.enabled, env, notify };
}

module.exports = { parseAllowedRoots, createOrchestrationRuntime, defaultWorkflowPath };
