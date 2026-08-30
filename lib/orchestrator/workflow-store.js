'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { normalizeRunContract } = require('./run-contract');

const TRANSITIONS = {
  draft: new Set(['queued', 'paused']),
  queued: new Set(['running', 'paused']),
  running: new Set(['waiting_user', 'verifying', 'failed', 'paused']),
  waiting_user: new Set(['running', 'paused', 'failed']),
  verifying: new Set(['completed', 'failed', 'paused']),
  completed: new Set(),
  failed: new Set(['queued', 'paused']),
  paused: new Set(['queued', 'running']),
};

function defaultPath() {
  return path.join(os.homedir(), 'AppData', 'Local', 'AgentBoard', 'workflows.json');
}

function legacyRunContract(workflow) {
  const goal = workflow && workflow.executionPlan && workflow.executionPlan.goal;
  return normalizeRunContract({
    goal: typeof goal === 'string' && goal.trim() ? goal : '完成用户目标',
    verify: { dod: ['完成用户目标'] },
  });
}

function normalizeLoadedWorkflow(workflow) {
  const normalized = { ...workflow };
  if (!normalized.autopilotMode) normalized.autopilotMode = 'suggest';
  try {
    normalized.runContract = normalized.runContract
      ? normalizeRunContract(normalized.runContract)
      : legacyRunContract(normalized);
  } catch {
    normalized.runContract = legacyRunContract(normalized);
  }
  normalized.autopilotMode = normalized.runContract.autopilotMode;
  if (!Array.isArray(normalized.observedEvidence)) normalized.observedEvidence = [];
  if (!Object.prototype.hasOwnProperty.call(normalized, 'lastSuggestion')) normalized.lastSuggestion = null;
  if (!Object.prototype.hasOwnProperty.call(normalized, 'progress')) normalized.progress = null;
  if (!Object.prototype.hasOwnProperty.call(normalized, 'lastReceipt')) normalized.lastReceipt = null;
  return normalized;
}

class WorkflowStore {
  constructor(filePath = defaultPath()) {
    this.filePath = filePath;
    this.data = { workflows: [], events: [] };
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (raw && Array.isArray(raw.workflows) && Array.isArray(raw.events)) {
        this.data = {
          workflows: raw.workflows.map(normalizeLoadedWorkflow),
          events: raw.events,
        };
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  save() {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tempPath = this.filePath + '.tmp';
    fs.writeFileSync(tempPath, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(tempPath, this.filePath);
  }

  emit(type, workflow) {
    this.data.events.push({ id: crypto.randomUUID(), type, workflowId: workflow.id, at: Date.now() });
  }

  create({
    projectPath,
    mode = 'project',
    agent = '',
    classification = null,
    executionPlan = null,
    requestedBy = 'human',
    autopilotMode = 'suggest',
    runContract = null,
  }) {
    const contract = runContract || normalizeRunContract({
      autopilotMode,
      goal: executionPlan && executionPlan.goal ? executionPlan.goal : '完成用户目标',
      verify: { dod: ['完成用户目标'] },
    });
    const workflow = {
      id: 'wf-' + crypto.randomUUID(), projectPath: String(projectPath), mode, agent: String(agent),
      requestedBy: String(requestedBy), classification, executionPlan,
      autopilotMode: contract.autopilotMode, runContract: normalizeRunContract(contract),
      observedEvidence: [], lastSuggestion: null, progress: null, lastReceipt: null,
      status: 'draft', controlOwner: null, leaseExpiresAt: 0, runCount: 0, lastError: '',
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    this.data.workflows.push(workflow);
    this.emit('created', workflow);
    this.save();
    return { ...workflow };
  }

  get(id) {
    const workflow = this.data.workflows.find((item) => item.id === id);
    return workflow ? { ...workflow } : null;
  }

  list() {
    return this.data.workflows.map((workflow) => ({ ...workflow }));
  }

  update(workflow, type) {
    workflow.updatedAt = Date.now();
    this.emit(type, workflow);
    this.save();
    return { ...workflow };
  }

  updateFields(id, fields, type = 'updated') {
    const workflow = this.data.workflows.find((item) => item.id === id);
    if (!workflow) throw new Error('workflow not found');
    Object.assign(workflow, fields || {});
    return this.update(workflow, type);
  }

  incrementRun(id) {
    const workflow = this.data.workflows.find((item) => item.id === id);
    if (!workflow) throw new Error('workflow not found');
    workflow.runCount += 1;
    return this.update(workflow, 'run_started');
  }

  release(id, owner = '') {
    const workflow = this.data.workflows.find((item) => item.id === id);
    if (!workflow) throw new Error('workflow not found');
    if (owner && workflow.controlOwner && workflow.controlOwner !== owner) {
      throw new Error('workflow is controlled by another owner');
    }
    workflow.controlOwner = null;
    workflow.leaseExpiresAt = 0;
    return this.update(workflow, 'released');
  }

  transition(id, nextStatus) {
    const workflow = this.data.workflows.find((item) => item.id === id);
    if (!workflow) throw new Error('workflow not found');
    if (!TRANSITIONS[workflow.status] || !TRANSITIONS[workflow.status].has(nextStatus)) {
      throw new Error(`illegal workflow transition: ${workflow.status} -> ${nextStatus}`);
    }
    workflow.status = nextStatus;
    return this.update(workflow, 'transition');
  }

  claim(id, owner, leaseMs = 60_000, now = Date.now()) {
    const workflow = this.data.workflows.find((item) => item.id === id);
    if (!workflow) throw new Error('workflow not found');
    const current = this.data.workflows.find((item) => item.projectPath === workflow.projectPath && item.controlOwner && item.leaseExpiresAt > now);
    if (current && current.id !== id) throw new Error('project is already controlled');
    workflow.controlOwner = String(owner);
    workflow.leaseExpiresAt = now + Number(leaseMs);
    return this.update(workflow, 'claim');
  }

  takeover(id, owner = 'human', now = Date.now()) {
    const workflow = this.data.workflows.find((item) => item.id === id);
    if (!workflow) throw new Error('workflow not found');
    workflow.controlOwner = String(owner);
    workflow.leaseExpiresAt = 0;
    if (workflow.status !== 'paused' && workflow.status !== 'completed') workflow.status = 'paused';
    return this.update(workflow, 'takeover');
  }
}

module.exports = { TRANSITIONS, WorkflowStore };
