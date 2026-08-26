'use strict';

const { executeProjectPlan } = require('./project-lifecycle');

class WorkflowRunner {
  constructor({ store, transport, allowedRoots = [], runCommand, owner = 'ai-monitor', leaseMs = 60_000 } = {}) {
    if (!store || !transport || typeof transport.run !== 'function') throw new Error('store and transport are required');
    this.store = store;
    this.transport = transport;
    this.allowedRoots = allowedRoots;
    this.runCommand = runCommand;
    this.owner = owner;
    this.leaseMs = leaseMs;
  }

  async run(id) {
    let workflow = this.store.get(id);
    if (!workflow) throw new Error('workflow not found');
    if (workflow.status === 'completed') return workflow;
    if (workflow.controlOwner === 'human') return workflow;
    if (workflow.status === 'draft' || workflow.status === 'failed') workflow = this.store.transition(id, 'queued');
    workflow = this.store.claim(id, this.owner, this.leaseMs);
    if (workflow.status === 'queued' || workflow.status === 'paused') workflow = this.store.transition(id, 'running');
    this.store.incrementRun(id);

    try {
      const lifecycleOptions = { allowedRoots: this.allowedRoots };
      if (this.runCommand) lifecycleOptions.runCommand = this.runCommand;
      const lifecycle = executeProjectPlan(workflow.executionPlan, lifecycleOptions);
      if (lifecycle.status === 'waiting_user') {
        this.store.updateFields(id, { lastError: lifecycle.reason }, 'waiting_user');
        this.store.transition(id, 'waiting_user');
        this.store.release(id, this.owner);
        return this.store.get(id);
      }

      const result = await this.transport.run({
        workflow: this.store.get(id), agent: workflow.agent,
        projectPath: workflow.projectPath, prompt: workflow.executionPlan.goal,
      });
      if (result.status === 'waiting_user') {
        this.store.updateFields(id, { lastError: result.reason || '需要人工确认' }, 'waiting_user');
        this.store.transition(id, 'waiting_user');
        this.store.release(id, this.owner);
        return this.store.get(id);
      }
      if (result.status !== 'completed' || result.code !== 0) {
        const message = result.error || result.stderr || `worker exited with ${result.code}`;
        this.store.updateFields(id, { lastError: message }, 'worker_failed');
        this.store.transition(id, 'failed');
        this.store.release(id, this.owner);
        return this.store.get(id);
      }
      this.store.transition(id, 'verifying');
      this.store.updateFields(id, { lastError: '' }, 'verified');
      this.store.transition(id, 'completed');
      this.store.release(id, this.owner);
      return this.store.get(id);
    } catch (error) {
      const current = this.store.get(id);
      if (current.status === 'running') {
        const message = error.message || String(error);
        if (/approval required/i.test(message)) {
          this.store.updateFields(id, { lastError: message.replace(/^approval required:\s*/i, '') }, 'approval_required');
          this.store.transition(id, 'waiting_user');
        } else {
          this.store.updateFields(id, { lastError: message }, 'runner_failed');
          this.store.transition(id, 'failed');
        }
      }
      this.store.release(id, this.owner);
      return this.store.get(id);
    }
  }
}

module.exports = { WorkflowRunner };
