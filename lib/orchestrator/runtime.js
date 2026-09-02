'use strict';

const path = require('node:path');
const { WorkflowStore } = require('./workflow-store');
const { AutoPilotSettingsStore } = require('./settings-store');
const { WorkflowRunner } = require('./runner');
const { createSuggestionService } = require('./suggestion-engine');
const { AutoLoop } = require('./auto-loop');
const { generateSupervisorReview } = require('./supervisor-review');
const { collectProjectEvidence } = require('./evidence-collector');
const { HeadlessTransport } = require('./transport');
const { createRoutingRuntime } = require('./routing/runtime');
const { getDataDir } = require('../runtime-paths');
const { createResearcher } = require('./researcher');

function parseAllowedRoots(value = '') {
  return String(value || '')
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => path.resolve(item));
}

function defaultWorkflowPath(env = process.env) {
  return path.join(getDataDir({ env }), 'workflows.json');
}

function createOrchestrationRuntime({
  env = process.env, filePath = defaultWorkflowPath(env), settingsPath, sessionStore, runCommand, onWorkflowChange, workbuddyCliPath, nodeExecutable,
  verifiedDispatchDependencies, autoDispatch, autoNow, routingNativeCapability, routingProfileFallback,
  routingAgentCapabilities, routingCachePath, routingAgentVersion, routingProbeObserver, reconcileEveryTurns, sessionProvisioners,
  supervisorReview, evidenceCollector, researcher, researchDependencies,
} = {}) {
  const store = new WorkflowStore(filePath);
  const settings = new AutoPilotSettingsStore(settingsPath || path.join(path.dirname(filePath), 'autopilot-settings.json'));
  const allowedRoots = parseAllowedRoots(env.AGENT_BOARD_ALLOWED_ROOTS);
  const transport = new HeadlessTransport({
    enabled: env.AGENT_BOARD_HEADLESS_EXECUTION === '1', env, workbuddyCliPath, nodeExecutable,
  });
  const runner = new WorkflowRunner({ store, transport, allowedRoots, runCommand });
  const suggestion = createSuggestionService({ store });
  const notify = (workflow) => {
    if (typeof onWorkflowChange === 'function') onWorkflowChange(workflow);
  };
  const routing = createRoutingRuntime({
    nativeCapability: routingNativeCapability,
    agentCapabilities: routingAgentCapabilities,
    profileFallback: routingProfileFallback,
    cachePath: routingCachePath,
    agentVersion: routingAgentVersion,
    onCatalogProbe: routingProbeObserver,
  });
  const configuredReconcileTurns = Number(env.AGENT_BOARD_AUTOPILOT_RECONCILE_TURNS);
  const configuredSupervisorReview = typeof supervisorReview === 'function'
    ? supervisorReview
    : env.AGENT_BOARD_SUPERVISOR_REVIEW === '0'
      ? null
      : (context) => generateSupervisorReview({ ...context, env });
  const configuredEvidenceCollector = typeof evidenceCollector === 'function'
    ? evidenceCollector
    : (context) => collectProjectEvidence({ ...context, runCommand, now: autoNow || (() => Date.now()) });
  const configuredResearcher = researcher && typeof researcher.research === 'function'
    ? researcher : createResearcher(researchDependencies || {});
  const auto = new AutoLoop({
    store, allowedRoots, resolveDependencies: verifiedDispatchDependencies,
    dispatch: autoDispatch, routingRuntime: routing, now: autoNow || (() => Date.now()),
    reconcileEveryTurns: Number.isInteger(reconcileEveryTurns)
      ? reconcileEveryTurns
      : (Number.isInteger(configuredReconcileTurns) ? configuredReconcileTurns : 3), onWorkflowChange: notify,
    supervisorReview: configuredSupervisorReview, evidenceCollector: configuredEvidenceCollector,
    sessionProvisioners: sessionProvisioners || {}, researcher: configuredResearcher,
  });
  auto.reconcileAll().catch(() => { auto.recordMonitoringFailureForActive('AUTOPILOT_STARTUP_FAILED'); });
  const configuredReconcileMs = Number(env.AGENT_BOARD_AUTOPILOT_RECONCILE_MS);
  const persistedReconcileMs = settings.get().autopilot.reconciliationIntervalMs;
  auto.startPeriodicReconciliation(Number.isInteger(configuredReconcileMs) && configuredReconcileMs > 0
    ? configuredReconcileMs : persistedReconcileMs);
  const stopSessionActivityMonitor = sessionStore && typeof sessionStore.onMessageIngested === 'function'
    ? sessionStore.onMessageIngested((activity) => { void auto.onSessionActivity(activity); })
    : () => {};
  return {
    store, settings, sessionStore, runner, auto, routing, suggestion, transport, allowedRoots, researcher: configuredResearcher,
    sessionProvisioners: sessionProvisioners || {}, taskDrafts: new Map(),
    headlessEnabled: transport.enabled, env, notify, stopSessionActivityMonitor,
  };
}

module.exports = { parseAllowedRoots, createOrchestrationRuntime, defaultWorkflowPath };
