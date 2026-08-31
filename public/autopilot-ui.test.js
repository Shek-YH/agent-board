'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { findWorkflowForSession, sessionSummary, detailForWorkflow } = require('./autopilot-ui');

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
    lastDecision: '继续收集证据', deliveryState: 'committed',
  });
});
