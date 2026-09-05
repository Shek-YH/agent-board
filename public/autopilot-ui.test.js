'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { findWorkflowForSession, sessionSummary, detailForWorkflow, taskContractView, createHostedSessionHandoffState } = require('./autopilot-ui');

test('matches only the Auto workflow bound to the same session and project', () => {
  const workflows = [
    { id: 'suggest', autopilotMode: 'suggest', agent: 'codex', binding: { sessionRef: 'codex:s-1', projectPath: 'C:\\work' } },
    { id: 'other-project', autopilotMode: 'auto', agent: 'codex', binding: { sessionRef: 'codex:s-1', projectPath: 'D:\\work' } },
    { id: 'match', autopilotMode: 'auto', agent: 'codex', binding: { sessionRef: 'codex:s-1', projectPath: 'C:\\work\\' } },
  ];
  assert.equal(findWorkflowForSession(workflows, { id: 'codex:s-1', agent: 'codex', project: 'c:/WORK' }).id, 'match');
  assert.equal(findWorkflowForSession(workflows, { id: 'codex:s-2', agent: 'codex', project: 'C:\\work' }), null);
});

test('builds safe card and detail summaries from workflow state', () => {
  const workflow = {
    autopilotMode: 'auto', autoState: 'WAITING_AGENT', runCount: 4,
    runContract: { goal: '修复 E2E', scope: { inScope: ['tests'], outOfScope: ['部署'] }, verify: { dod: ['测试通过'] } },
    progress: { completed: 0, total: 1, percent: 0, evidence: [] },
    lastRouting: { modelId: 'sol', reasoningLevel: 'high', reasonCode: 'ROUTE_ESCALATED' },
    lastDecision: { summary: '继续收集证据' },
  };
  assert.deepEqual(sessionSummary(workflow), { kind: 'running', label: 'AI 托管 · 第 4 轮', title: 'AutoPilot：等待 Agent · 第 4 轮', state: 'WAITING_AGENT' });
  assert.deepEqual(detailForWorkflow(workflow, { state: 'committed' }), {
    goal: '修复 E2E', scope: ['tests', '范围外：部署'], dod: [{ description: '测试通过', passed: false }],
    progress: { completed: 0, total: 1, percent: 0 }, currentModel: 'sol', reasoning: 'high', routeReason: 'ROUTE_ESCALATED',
    lastDecision: '继续收集证据', supervisorReview: null, evidence: { checks: [], skipped: 0 },
    handoffProgress: { completed: 0, total: 0, percent: 0 }, currentStep: null, blockReason: '', needHumanReason: '', deliveryState: 'committed',
  });
});

test('builds a dynamic Task Contract view without copying unknown or sensitive fields', () => {
  const direct = taskContractView({
    classification: { kind: 'direct', confidence: 0.95, reasons: ['问答'] }, goal: '解释代码',
    inScope: ['不应展示'], dod: ['不应展示'], evidence: ['不应展示'], source: { selectedBy: 'none' },
    humanGate: { required: false, reason: '' }, apiKey: 'secret-value', prompt: 'hidden',
  });
  assert.deepEqual(direct.sections, []);
  assert.equal(direct.kindLabel, '直接处理');
  assert.doesNotMatch(JSON.stringify(direct), /secret-value|apiKey|prompt|hidden/);

  const project = taskContractView({
    classification: { kind: 'project', confidence: 0.9, reasons: ['PRD'] }, goal: '完成项目',
    inScope: ['Phase 0'], outOfScope: ['真实发布'], dod: ['测试通过'], evidence: ['node --test'], risks: ['需审批'],
    source: { fileName: 'PRD.md', version: 'v1.0', selectedBy: 'user' },
    humanGate: { required: true, reason: '等待人工审批' },
  });
  assert.deepEqual(project.sections.map((item) => item.key), ['inScope', 'outOfScope', 'dod', 'evidence', 'risks']);
  assert.equal(project.sourceLabel, 'PRD.md · v1.0');
  assert.equal(project.humanGate.required, true);
});

test('exposes safe handoff progress and blocking reason in the workflow detail', () => {
  const detail = detailForWorkflow({
    runContract: { goal: '接力任务', verify: { dod: ['当前步骤'] } },
    handoffChain: [
      { id: 'build', order: 1, agent: 'codex', status: 'done' },
      { id: 'review', order: 2, agent: 'claude', status: 'need_human', result: { reason: '身份需要确认' } },
    ],
    lastError: 'HANDOFF_NEED_HUMAN',
  });
  assert.deepEqual(detail.handoffProgress, { completed: 1, total: 2, percent: 50 });
  assert.deepEqual(detail.currentStep, { id: 'review', order: 2, agent: 'claude', status: 'need_human' });
  assert.equal(detail.blockReason, 'HANDOFF_NEED_HUMAN');
  assert.equal(detail.needHumanReason, '身份需要确认');
});

test('exposes hosted round state without exposing Agent reply text', () => {
  const detail = detailForWorkflow({
    autopilotMode: 'auto', autoState: 'WAITING_AGENT',
    runContract: { goal: '托管任务', verify: { dod: ['完成'] } },
    hostedControl: {
      enabled: true, sourceTaskId: 'source-1', targetTaskId: 'target-1', hostId: 'host-1', round: 3,
      lastAgentMessageStatus: 'question', blockedReason: 'raw=secret should not be shown', lastAgentMessageText: '不要输出',
    },
  });
  assert.deepEqual(detail.hostedControl, {
    enabled: true, sourceTaskId: 'source-1', targetTaskId: 'target-1', hostId: 'host-1', round: 3,
    lastAgentMessageStatus: 'question', blockedReason: 'raw=secret should not be shown',
  });
  assert.doesNotMatch(JSON.stringify(detail), /不要输出|lastAgentMessageText/);
});

test('exposes research progress while keeping raw source material out of the UI view', () => {
  const view = taskContractView({
    classification: { kind: 'standard', confidence: 0.62 }, goal: '完成目标', generationStatus: 'research_required', confidence: 0.62,
    researchableFields: ['inScope', 'dod'], humanRequiredFields: [],
    research: {
      status: 'researching', confidence: 0.45, unresolvedQuestions: ['需要确认范围'],
      sources: [{ kind: 'external', url: 'https://docs.example.com/a', title: 'Docs', content: 'token=secret' }],
    },
  });
  assert.equal(view.generationStatus, 'research_required');
  assert.equal(view.research.status, 'researching');
  assert.deepEqual(view.researchableFields, ['inScope', 'dod']);
  assert.doesNotMatch(JSON.stringify(view), /token=secret|content/);
});

test('hosted session handoff keeps a temporary UI item until the real session is indexed', () => {
  const handoff = createHostedSessionHandoffState({ now: () => 10_000 });
  const pending = handoff.add({
    sessionRef: 'codex:11111111-1111-4111-8111-111111111111',
    agent: 'codex', projectPath: 'C:/work/app', workflowId: 'wf-1',
  });

  assert.equal(pending.kind, 'hosted-session-handoff');
  assert.equal(pending.state, 'created');
  assert.equal(handoff.listForAgent('codex')[0].sessionRef, pending.sessionRef);

  handoff.update(pending.sessionRef, { state: 'starting' });
  assert.equal(handoff.get(pending.sessionRef).state, 'starting');
  assert.equal(handoff.reconcile([{ id: 'codex:other-session' }]), 0);
  assert.equal(handoff.get(pending.sessionRef).state, 'starting');

  assert.equal(handoff.reconcile([{ id: pending.sessionRef }]), 1);
  assert.equal(handoff.get(pending.sessionRef), null);
});

test('hosted session handoff can be manually hidden without changing the real session reference', () => {
  const handoff = createHostedSessionHandoffState({ now: () => 10_000 });
  const pending = handoff.add({
    sessionRef: 'codex:22222222-2222-4222-8222-222222222222',
    agent: 'codex', projectPath: 'C:/work/app', workflowId: 'wf-2',
  });

  assert.equal(handoff.remove(pending.sessionRef), true);
  assert.equal(handoff.get(pending.sessionRef), null);
  assert.equal(handoff.remove(pending.sessionRef), false);
});
