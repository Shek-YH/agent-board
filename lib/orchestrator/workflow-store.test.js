'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { WorkflowStore } = require('./workflow-store');
const { normalizeRunContract } = require('./run-contract');

function storePath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-workflow-'));
  return path.join(dir, 'workflows.json');
}

test('workflow transitions through the supported lifecycle', () => {
  const store = new WorkflowStore(storePath());
  const workflow = store.create({ projectPath: 'C:\\work\\app', mode: 'project', agent: 'codex' });
  assert.equal(workflow.status, 'draft');
  store.transition(workflow.id, 'queued');
  store.transition(workflow.id, 'running');
  store.transition(workflow.id, 'verifying');
  store.transition(workflow.id, 'completed');
  assert.equal(store.get(workflow.id).status, 'completed');
});

test('illegal workflow transition is rejected', () => {
  const store = new WorkflowStore(storePath());
  const workflow = store.create({ projectPath: 'C:\\work\\app', mode: 'project', agent: 'codex' });
  assert.throws(() => store.transition(workflow.id, 'completed'), /illegal workflow transition/);
});

test('only one active owner may control a project', () => {
  const store = new WorkflowStore(storePath());
  const first = store.create({ projectPath: 'C:\\work\\app', mode: 'project', agent: 'codex' });
  const second = store.create({ projectPath: 'C:\\work\\app', mode: 'project', agent: 'claude' });
  store.claim(first.id, 'ai', 60_000, 1000);
  assert.throws(() => store.claim(second.id, 'ai', 60_000, 1001), /project is already controlled/);
});

test('human takeover pauses AI ownership', () => {
  const store = new WorkflowStore(storePath());
  const workflow = store.create({ projectPath: 'C:\\work\\app', mode: 'project', agent: 'codex' });
  store.claim(workflow.id, 'ai', 60_000, 1000);
  store.takeover(workflow.id, 'human', 1001);
  const current = store.get(workflow.id);
  assert.equal(current.controlOwner, 'human');
  assert.equal(current.status, 'paused');
});

test('expired AI lease can be reclaimed', () => {
  const store = new WorkflowStore(storePath());
  const first = store.create({ projectPath: 'C:\\work\\app', mode: 'project', agent: 'codex' });
  const second = store.create({ projectPath: 'C:\\work\\app', mode: 'project', agent: 'claude' });
  store.claim(first.id, 'ai', 10, 1000);
  store.claim(second.id, 'ai', 60_000, 1011);
  assert.equal(store.get(second.id).controlOwner, 'ai');
});

test('stores the immutable run contract and empty observed evidence', () => {
  const store = new WorkflowStore(storePath());
  const workflow = store.create({
    projectPath: 'C:\\work\\app', mode: 'project', agent: 'codex',
    executionPlan: { goal: '完成目标' },
    runContract: normalizeRunContract({
      goal: '完成目标', verify: { dod: ['测试通过'] },
    }),
  });
  const loaded = new WorkflowStore(store.filePath).get(workflow.id);
  assert.equal(loaded.autopilotMode, 'suggest');
  assert.deepEqual(loaded.runContract.verify.dod, ['测试通过']);
  assert.deepEqual(loaded.observedEvidence, []);
  assert.equal(loaded.lastSuggestion, null);
});

test('migrates a legacy workflow without inventing completion evidence', () => {
  const filePath = storePath();
  fs.writeFileSync(filePath, JSON.stringify({
    workflows: [{
      id: 'legacy-1', projectPath: 'C:\\work\\legacy', executionPlan: { goal: '维护旧项目' },
      status: 'completed', runCount: 1,
    }],
    events: [],
  }), 'utf8');
  const workflow = new WorkflowStore(filePath).get('legacy-1');
  assert.equal(workflow.autopilotMode, 'suggest');
  assert.deepEqual(workflow.runContract.verify.dod, ['完成用户目标']);
  assert.deepEqual(workflow.observedEvidence, []);
  assert.equal(workflow.lastSuggestion, null);
});

test('persists auto FSM state, single-session binding, explicit evidence, and receipts', () => {
  const store = new WorkflowStore(storePath());
  const workflow = store.create({
    projectPath: 'C:\\work\\app', mode: 'project', agent: 'codex', binding: {
      sessionRef: 'session-1', agent: 'codex', projectPath: 'C:\\work\\app',
    },
    runContract: normalizeRunContract({ autopilotMode: 'auto', goal: '完成目标', verify: { dod: ['测试通过'] } }),
  });
  assert.equal(workflow.autoState, 'OFF');
  assert.deepEqual(workflow.binding, { sessionRef: 'session-1', agent: 'codex', projectPath: 'C:\\work\\app' });
  assert.equal(store.transitionState(workflow.id, 'PREFLIGHT').status, 'queued');
  const withEvidence = store.recordEvidence(workflow.id, {
    dodIndex: 0, passed: true, summary: '测试已通过', source: 'node --test',
  });
  assert.deepEqual(withEvidence.observedEvidence, [{
    dodIndex: 0, passed: true, summary: '测试已通过', source: 'node --test',
  }]);
  const withReceipt = store.updateFields(workflow.id, { runReceipt: { finalState: 'DONE' } }, 'receipt_created');
  assert.deepEqual(withReceipt.runReceipt, { finalState: 'DONE' });
});

test('persists routing configuration, last route summary, and safe audit entries', () => {
  const store = new WorkflowStore(storePath());
  const workflow = store.create({ projectPath: 'C:\\work\\app', mode: 'project', agent: 'codex' });
  assert.equal(workflow.routingConfig.enabled, false);
  const updated = store.recordRouting(workflow.id, {
    summary: {
      enabled: true, action: 'apply', reasonCode: 'ROUTE_ESCALATED', modelId: 'strong', reasoningLevel: 'high',
    },
    auditEvent: { schemaVersion: 1, event: 'profile_verified', fingerprint: 'route-1' },
  });
  assert.equal(updated.lastRouting.modelId, 'strong');
  assert.equal(updated.routingEscalations, 1);
  assert.deepEqual(updated.routingAudit, [{ schemaVersion: 1, event: 'profile_verified', fingerprint: 'route-1' }]);
  assert.equal(new WorkflowStore(store.filePath).get(workflow.id).lastRouting.reasoningLevel, 'high');
});

test('WAL records are append-only and pending dispatches can be identified without replay', () => {
  const store = new WorkflowStore(storePath());
  const workflow = store.create({
    projectPath: 'C:\\work\\app', agent: 'codex',
    runContract: normalizeRunContract({ autopilotMode: 'auto', goal: '完成目标', verify: { dod: ['完成'] } }),
    binding: { sessionRef: 's1', agent: 'codex', projectPath: 'C:\\work\\app' },
  });
  store.appendWal(workflow.id, { operationId: 'op-1', state: 'pending', phase: 'DISPATCHING', sendAttempted: false });
  assert.equal(store.listPendingWal(workflow.id).length, 1);
  store.appendWal(workflow.id, { operationId: 'op-1', state: 'reconcile_required', phase: 'SEND', sendAttempted: true });
  assert.equal(store.listPendingWal(workflow.id).length, 0);
  assert.equal(store.listWal(workflow.id).length, 2);
  const loaded = new WorkflowStore(store.filePath).get(workflow.id);
  assert.equal(loaded.autoState, 'OFF');
  assert.equal(new WorkflowStore(store.filePath).listWal(workflow.id).length, 2);
});
