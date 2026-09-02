'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { WorkflowStore } = require('./workflow-store');
const { normalizeRunContract } = require('./run-contract');
const { DEFAULT_SETTINGS, createSettingsSnapshot } = require('./settings-store');
const { buildPermissionSnapshot } = require('./permission-snapshot');

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

test('lists only safe workflow event fields for historical intervention analysis', () => {
  const store = new WorkflowStore(storePath());
  const workflow = store.create({ projectPath: 'C:\\work\\app', mode: 'project', agent: 'codex' });
  store.takeover(workflow.id, 'human', 1001);
  const events = store.listEvents(workflow.id);
  assert.deepEqual(events.map((event) => event.type), ['created', 'takeover']);
  assert.ok(events.every((event) => event.workflowId === workflow.id && Number.isFinite(event.at)));
  assert.equal('projectPath' in events[0], false);
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

test('invalid persisted handoffChain fails closed instead of falling back to legacy execution', () => {
  const filePath = storePath();
  fs.writeFileSync(filePath, JSON.stringify({
    workflows: [{
      id: 'invalid-chain', projectPath: 'C:\\work\\invalid-chain', agent: 'codex', autopilotMode: 'auto', status: 'running',
      runContract: {
        autopilotMode: 'auto', goal: '执行', verify: { dod: ['完成'] },
        handoffChain: [{ id: 'build', order: 1, agent: 'codex', goal: '构建', dod: ['完成'], status: 'done', dependsOn: [] }],
      },
      handoffChain: [{ id: 'build', order: 1, agent: 'codex', goal: '构建', dod: ['完成'], status: 'done', dependsOn: [] }],
    }],
    events: [],
  }), 'utf8');

  const workflow = new WorkflowStore(filePath).get('invalid-chain');

  assert.equal(workflow.autoState, 'PAUSED');
  assert.equal(workflow.status, 'paused');
  assert.equal(workflow.lastError, 'HANDOFF_CHAIN_INVALID');
  assert.equal(workflow.stopReason, 'Need Human');
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

test('persists the exact desktop session title needed for verified UI automation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-title-'));
  const store = new WorkflowStore(path.join(dir, 'workflows.json'));
  const workflow = store.create({
    projectPath: 'C:\\work\\app', agent: 'codex', binding: {
      sessionRef: 'codex:session-1', agent: 'codex', projectPath: 'C:\\work\\app', title: 'Visible title',
    },
    runContract: normalizeRunContract({ autopilotMode: 'auto', goal: '完成目标', verify: { dod: ['完成'] } }),
  });

  assert.equal(workflow.binding.title, 'Visible title');
});

test('persists only a normalized safe Task Contract snapshot', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-intake-snapshot-'));
  const store = new WorkflowStore(path.join(dir, 'workflows.json'));
  const workflow = store.create({
    projectPath: 'C:\\work\\app', agent: 'codex',
    runContract: normalizeRunContract({ autopilotMode: 'auto', goal: '完成目标', verify: { dod: ['完成'] } }),
    taskContract: {
      schemaVersion: 1,
      classification: { kind: 'standard', confidence: 0.9, reasons: ['API'], requiresPrd: false },
      source: { selectedBy: 'none' }, goal: '完成目标', inScope: ['API'], outOfScope: ['不发布'],
      dod: ['完成'], evidence: ['node --test'], risks: [], assumptions: [], missingFields: [], inferredFields: [],
      humanGate: { required: false, reason: '' }, apiKey: 'secret-value', prompt: 'hidden',
    },
  });

  const loaded = new WorkflowStore(store.filePath).get(workflow.id);
  assert.equal(loaded.taskContract.classification.kind, 'standard');
  assert.equal(loaded.taskContract.runtimeContext.projectPathSource, 'session');
  assert.doesNotMatch(JSON.stringify(loaded.taskContract), /secret-value|apiKey|prompt|hidden/);
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
  assert.equal(updated.routingAudit.length, 1);
  assert.equal(updated.routingAudit[0].schemaVersion, 1);
  assert.equal(updated.routingAudit[0].event, 'PROFILE_VERIFIED');
  assert.equal('prompt' in updated.routingAudit[0], false);
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

test('WAL keeps a safe delivery boundary for post-SEND reconciliation', () => {
  const store = new WorkflowStore(storePath());
  const workflow = store.create({ projectPath: 'C:\\work\\app', mode: 'project', agent: 'codex' });
  store.appendWal(workflow.id, {
    operationId: 'op-delivery', state: 'pending', phase: 'DISPATCHING', sendAttempted: false,
    instruction: 'prompt must not persist',
    deliverySnapshot: {
      agent: 'codex', threadId: 'thread-1', filePath: 'C:\\sessions\\thread.jsonl', byteOffset: 42,
      capturedAt: 1_700_000_000_000, session_seq_before: 7, secret: 'drop-me',
    },
  });

  const loaded = new WorkflowStore(store.filePath).listPendingWal(workflow.id)[0];
  assert.deepEqual(loaded.deliverySnapshot, {
    agent: 'codex', threadId: 'thread-1', filePath: 'C:\\sessions\\thread.jsonl', byteOffset: 42,
    capturedAt: 1_700_000_000_000, sessionSeqBefore: 7,
  });
  assert.doesNotMatch(JSON.stringify(loaded), /prompt must not persist|drop-me/);
});

test('accepted turn route snapshots are immutable across configuration changes and never store instruction content', () => {
  const store = new WorkflowStore(storePath());
  const workflow = store.create({ projectPath: 'C:\\work\\app', mode: 'project', agent: 'codex' });
  const accepted = store.acceptTurn(workflow.id, {
    turnId: 'turn-1', attempt: 1,
    routeRequest: { complexityTier: 'C2', thinkingTier: 'T2', promptPolicy: 'P1' },
    resolvedProfile: { modelId: 'strong', reasoningLevel: 'high' },
    verification: { verified: true, source: 'native' },
  });
  const snapshot = accepted.acceptedTurnSnapshot;
  const view = store.get(workflow.id);
  view.acceptedTurnSnapshot.resolvedProfile.modelId = 'mutated';
  store.updateFields(workflow.id, { routingConfig: { enabled: true, preset: 'quality' } }, 'config_changed');

  assert.deepEqual(store.get(workflow.id).acceptedTurnSnapshot, snapshot);
  assert.deepEqual(store.get(workflow.id).acceptedTurn, snapshot);
  assert.throws(() => store.updateFields(workflow.id, { acceptedTurnSnapshot: {} }), /immutable/);
  assert.equal(JSON.stringify(store.get(workflow.id)).includes('mutated'), false);
});

test('WAL strips instruction, token, and secret fields before persistence', () => {
  const store = new WorkflowStore(storePath());
  const workflow = store.create({ projectPath: 'C:\\work\\app', mode: 'project', agent: 'codex' });
  const wal = store.appendWal(workflow.id, {
    operationId: 'profile-op', kind: 'profile_apply', phase: 'MODEL_APPLY', state: 'pending',
    instruction: 'prompt should not persist', token: 'token should not persist', secret: 'secret should not persist',
  });

  assert.equal('instruction' in wal, false);
  assert.equal('token' in wal, false);
  assert.equal('secret' in wal, false);
  assert.equal(JSON.stringify(new WorkflowStore(store.filePath).listWal(workflow.id)).includes('prompt should not persist'), false);
});

test('dispatch records retain only safe session and delivery proof envelopes', () => {
  const store = new WorkflowStore(storePath());
  const workflow = store.create({ projectPath: 'C:\\work\\app', mode: 'project', agent: 'codex' });
  const record = store.appendDispatchRecord(workflow.id, {
    instruction: 'prompt must not persist', token: 'token must not persist',
    sessionSeqBefore: 12,
    identityProof: {
      verified: true, strongAnchor: true, anchor: 'session-secret', source: 'uia', token: 'drop-me',
    },
    deliveryProof: {
      verified: true, delivered: true, messageId: 'message-secret', source: 'jsonl', code: 'DELIVERED',
    },
    startedAt: 1_700_000_000_000, completedAt: 1_700_000_000_100,
  });

  assert.equal(record.sessionSeqBefore, 12);
  assert.equal(record.identityProof.verified, true);
  assert.equal(record.identityProof.strongAnchor, true);
  assert.equal(record.identityProof.source, 'uia');
  assert.match(record.identityProof.anchorFingerprint, /^[a-f0-9]{32}$/);
  assert.equal(record.deliveryProof.verified, true);
  assert.equal(record.deliveryProof.delivered, true);
  assert.equal(record.deliveryProof.source, 'jsonl');
  assert.equal(record.deliveryProof.resultCode, 'DELIVERED');
  assert.match(record.deliveryProof.proofIdFingerprint, /^[a-f0-9]{32}$/);
  assert.equal(record.startedAt, 1_700_000_000_000);
  assert.equal(record.completedAt, 1_700_000_000_100);
  const serialized = JSON.stringify(new WorkflowStore(store.filePath).listDispatchRecords(workflow.id));
  assert.doesNotMatch(serialized, /prompt must not persist|token must not persist|session-secret|message-secret|drop-me/);
});

test('persists immutable Settings and Permission Snapshots and rejects replacement', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-immutable-snapshots-'));
  const store = new WorkflowStore(path.join(dir, 'workflows.json'));
  const projectPath = path.join(dir, 'app');
  fs.mkdirSync(projectPath);
  const settingsSnapshot = createSettingsSnapshot(DEFAULT_SETTINGS, 1700000000000);
  const permissionSnapshot = buildPermissionSnapshot({ projectPath, now: 1700000000000 });
  const workflow = store.create({
    projectPath, agent: 'codex', settingsSnapshot, permissionSnapshot,
    runContract: normalizeRunContract({ autopilotMode: 'auto', goal: '完成目标', verify: { dod: ['完成'] } }),
  });
  assert.match(workflow.settingsSnapshot.snapshotHash, /^[a-f0-9]{64}$/);
  assert.match(workflow.permissionSnapshot.snapshotHash, /^[a-f0-9]{64}$/);
  assert.throws(() => store.updateFields(workflow.id, { settingsSnapshot: createSettingsSnapshot(DEFAULT_SETTINGS) }), /settings snapshot is immutable/);
  assert.throws(() => store.updateFields(workflow.id, { permissionSnapshot: buildPermissionSnapshot({ projectPath }) }), /permission snapshot is immutable/);
  const loaded = new WorkflowStore(store.filePath).get(workflow.id);
  assert.equal(loaded.settingsSnapshot.capturedAt, 1700000000000);
  assert.equal(loaded.permissionSnapshot.capturedAt, 1700000000000);
});

test('dispatch records hash a source id when the delivery reader exposes no message id', () => {
  const store = new WorkflowStore(storePath());
  const workflow = store.create({ projectPath: 'C:\\work\\app', mode: 'project', agent: 'codex' });
  const record = store.appendDispatchRecord(workflow.id, {
    deliveryProof: { verified: true, delivered: true, sourceId: 'codex-source-secret' },
  });

  assert.match(record.deliveryProof.proofIdFingerprint, /^[a-f0-9]{32}$/);
  assert.doesNotMatch(JSON.stringify(new WorkflowStore(store.filePath).listDispatchRecords(workflow.id)), /codex-source-secret/);
});

test('persists and updates handoffChain steps without losing legacy workflow binding', () => {
  const filePath = storePath();
  const store = new WorkflowStore(filePath);
  const workflow = store.create({
    projectPath: 'C:\\work\\app', mode: 'project', agent: 'codex',
    binding: { sessionRef: 'codex:session-1', agent: 'codex', projectPath: 'C:\\work\\app' },
    runContract: normalizeRunContract({ autopilotMode: 'auto', goal: '完成目标', verify: { dod: ['完成'] }, handoffChain: [
      { id: 'implement', order: 1, agent: 'codex', goal: '实现', dod: ['完成'], evidence: ['测试'], dependsOn: [] },
      { id: 'review', order: 2, agent: 'claude', goal: '审核', dod: ['通过'], evidence: ['审核'], dependsOn: ['implement'] },
    ] }),
  });

  assert.equal(workflow.binding.sessionRef, 'codex:session-1');
  assert.ok(Array.isArray(workflow.handoffChain));
  if (!Array.isArray(workflow.handoffChain)) return;
  assert.equal(workflow.handoffChain[0].status, 'pending');
  const updated = store.updateHandoffStep(workflow.id, 'implement', {
    status: 'done', completedAt: 1234, result: { summary: '完成' }, evidenceSnapshot: { verified: true, completed: true },
  });
  assert.equal(updated.handoffChain[0].status, 'done');
  assert.equal(updated.handoffChain[1].status, 'ready');
  const loaded = new WorkflowStore(filePath).get(workflow.id);
  assert.equal(loaded.handoffChain[0].completedAt, 1234);
  assert.equal(loaded.handoffChain[1].status, 'ready');
  assert.equal(loaded.binding.agent, 'codex');
});

test('persists workflow researchState across restart and keeps it bounded', () => {
  const filePath = storePath();
  const store = new WorkflowStore(filePath);
  const workflow = store.create({
    projectPath: 'C:\\work\\app', agent: 'codex',
    taskContract: { goal: '研究目标', classification: { kind: 'standard', confidence: 0.62 } },
  });
  const updated = store.updateResearchState(workflow.id, {
    status: 'completed', attempts: 1, confidence: 0.9,
    sources: [{ kind: 'local', path: 'README.md', title: 'README', content: 'should not persist' }],
    unresolvedQuestions: ['password=secret'], needsHumanReason: 'prompt=secret',
  });
  assert.equal(updated.researchState.status, 'completed');
  const loaded = new WorkflowStore(filePath).get(workflow.id);
  assert.equal(loaded.researchState.status, 'completed');
  assert.equal(loaded.researchState.confidence, 0.9);
  assert.doesNotMatch(JSON.stringify(loaded), /should not persist|password=secret|prompt=secret/);
});

test('persists hosted task relation and bounded round state across restart', () => {
  const filePath = storePath();
  const store = new WorkflowStore(filePath);
  const workflow = store.create({
    projectPath: 'C:\\work\\app', agent: 'codex', autopilotMode: 'auto',
    hostedControl: {
      enabled: true, sourceTaskId: 'source-task', targetTaskId: 'target-task', hostId: 'host-1', round: 2,
      lastSentMessageId: 'sent-fingerprint', lastAgentMessageId: 'reply-fingerprint', lastAgentMessageStatus: 'question',
    },
  });
  const loaded = new WorkflowStore(filePath).get(workflow.id);

  assert.equal(loaded.hostedControl.enabled, true);
  assert.equal(loaded.hostedControl.sourceTaskId, 'source-task');
  assert.equal(loaded.hostedControl.round, 2);
  assert.equal(loaded.hostedControl.lastAgentMessageStatus, 'question');
});

test('cannot mark a handoff step DONE while its dependencies are unfinished', () => {
  const store = new WorkflowStore(storePath());
  const workflow = store.create({
    projectPath: 'C:\\work\\app', agent: 'codex',
    runContract: normalizeRunContract({ autopilotMode: 'auto', goal: '完成目标', verify: { dod: ['完成'] }, handoffChain: [
      { id: 'build', order: 1, agent: 'codex', goal: '构建', dod: ['完成'], dependsOn: [] },
      { id: 'review', order: 2, agent: 'claude', goal: '审核', dod: ['通过'], dependsOn: ['build'] },
    ] }),
  });
  assert.throws(() => store.updateHandoffStep(workflow.id, 'review', {
    status: 'done', evidenceSnapshot: { verified: true, completed: true },
  }), /dependencies|依赖/);
  assert.equal(store.get(workflow.id).handoffChain[1].status, 'pending');
});
