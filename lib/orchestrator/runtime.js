'use strict';

const os = require('node:os');
const path = require('node:path');
const { WorkflowStore } = require('./workflow-store');
const { WorkflowRunner } = require('./runner');
const { createSuggestionService } = require('./suggestion-engine');
const { HeadlessTransport } = require('./transport');

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

function createOrchestrationRuntime({ env = process.env, filePath = defaultWorkflowPath(), runCommand, onWorkflowChange, workbuddyCliPath, nodeExecutable } = {}) {
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
  return { store, runner, suggestion, transport, allowedRoots, headlessEnabled: transport.enabled, env, notify };
}

module.exports = { parseAllowedRoots, createOrchestrationRuntime, defaultWorkflowPath };
