'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildTaskContract,
  classifyTask,
  normalizeTaskContract,
} = require('./task-intake');

test('classifies direct, light, standard, project, and high-risk tasks deterministically', () => {
  assert.equal(classifyTask({ goal: '1+1 等于多少？' }).kind, 'direct');
  assert.equal(classifyTask({ goal: '把当前页面的提交按钮改成蓝色，并运行相关测试。' }).kind, 'light');
  assert.equal(classifyTask({ goal: '修复登录 API，修改多个文件并补充单元测试。' }).kind, 'standard');
  assert.equal(classifyTask({ goal: '根据 PRD 分阶段完成 Web、API、数据库和 Worker 多模块项目。' }).kind, 'project');
  const risky = classifyTask({ goal: '把内容真实发布到小红书并自动回复评论。' });
  assert.equal(risky.kind, 'high_risk');
  assert.equal(risky.requiresPrd, false);
});

test('direct tasks produce a minimal contract without invented scope, DoD, or evidence', () => {
  const contract = buildTaskContract({ goal: '解释这段代码' });

  assert.equal(contract.classification.kind, 'direct');
  assert.equal(contract.goal, '解释这段代码');
  assert.deepEqual(contract.inScope, []);
  assert.deepEqual(contract.outOfScope, []);
  assert.deepEqual(contract.dod, []);
  assert.deepEqual(contract.evidence, []);
  assert.equal(contract.humanGate.required, false);
  assert.deepEqual(contract.source, { fileName: '', version: '', sha256: '', modifiedAt: null, selectedBy: 'none' });
});

test('light tasks receive only explicit minimum defaults and mark every inference', () => {
  const contract = buildTaskContract({ goal: '修改一处按钮文案' });

  assert.equal(contract.classification.kind, 'light');
  assert.deepEqual(contract.dod, ['完成目标所述修改并通过相关检查']);
  assert.deepEqual(contract.evidence, ['变更文件清单和相关检查结果']);
  assert.deepEqual(contract.inScope, []);
  assert.ok(contract.inferredFields.includes('dod'));
  assert.ok(contract.inferredFields.includes('evidence'));
});

test('user goal wins over PRD fields while explicit PRD scope and verification are retained', () => {
  const contract = buildTaskContract({
    goal: '只完成 Task Intake Phase 0 和 Phase 1',
    selectedBy: 'user',
    source: {
      fileName: 'Product_PRD_v1.0.md', version: 'v1.0', sha256: 'a'.repeat(64), modifiedAt: '2026-08-31T12:00:00.000Z',
    },
    prd: {
      title: '完整产品', goals: ['完成整个产品'], phases: ['Phase 0', 'Phase 1'],
      inScope: ['Task Intake'], outOfScope: ['真实外部发布'], dod: ['单元测试通过'],
      evidence: ['node --test'], risks: ['平台写操作需要审批'], constraints: ['不得使用受限许可证素材'],
    },
  });

  assert.equal(contract.goal, '只完成 Task Intake Phase 0 和 Phase 1');
  assert.equal(contract.classification.kind, 'project');
  assert.deepEqual(contract.inScope, ['Task Intake', 'Phase 0', 'Phase 1']);
  assert.deepEqual(contract.outOfScope, ['真实外部发布', '不得使用受限许可证素材']);
  assert.deepEqual(contract.dod, ['单元测试通过']);
  assert.deepEqual(contract.evidence, ['node --test']);
  assert.equal(contract.source.fileName, 'Product_PRD_v1.0.md');
  assert.equal(contract.source.sha256, 'a'.repeat(64));
  assert.ok(!contract.inferredFields.includes('goal'));
});

test('missing PRD fields remain missing instead of being fabricated for a project task', () => {
  const contract = buildTaskContract({ goal: '创建一个多模块新项目，包含 Web、API 和数据库' });

  assert.equal(contract.classification.kind, 'project');
  assert.equal(contract.classification.requiresPrd, true);
  assert.ok(contract.missingFields.includes('source'));
  assert.ok(contract.missingFields.includes('inScope'));
  assert.ok(contract.missingFields.includes('outOfScope'));
  assert.ok(contract.missingFields.includes('dod'));
  assert.ok(contract.missingFields.includes('evidence'));
});

test('high-risk tasks always require a human gate and keep the reason explicit', () => {
  const contract = buildTaskContract({ goal: '删除生产数据库中的用户数据' });

  assert.equal(contract.classification.kind, 'high_risk');
  assert.equal(contract.humanGate.required, true);
  assert.match(contract.humanGate.reason, /人工审批/);
  assert.ok(contract.risks.length > 0);
});

test('normalization drops secrets, prompts, unknown fields, and invalid source metadata', () => {
  const contract = normalizeTaskContract({
    schemaVersion: 1,
    classification: { kind: 'standard', confidence: 0.8, reasons: ['修改 API'], requiresPrd: false },
    runtimeContext: { projectPathSource: 'client', agentSource: 'session', sessionRefSource: 'session', settingsSource: 'persistent' },
    source: { fileName: 'PRD.md', version: 'v1', sha256: 'not-a-hash', selectedBy: 'user' },
    goal: '修复 API', inScope: ['API', 'API_KEY=leaked'], outOfScope: [],
    dod: ['测试通过'], evidence: ['Authorization: Bearer leaked'], risks: ['cookie=leaked'],
    assumptions: ['普通假设'], missingFields: [], inferredFields: [],
    humanGate: { required: false, reason: '' },
    apiKey: 'secret', prompt: 'hidden', commands: ['rm -rf /'],
  });

  const serialized = JSON.stringify(contract);
  assert.equal(contract.runtimeContext.projectPathSource, 'session');
  assert.deepEqual(contract.inScope, ['API']);
  assert.deepEqual(contract.evidence, []);
  assert.deepEqual(contract.risks, []);
  assert.equal(contract.source.sha256, '');
  assert.doesNotMatch(serialized, /leaked|apiKey|prompt|commands|rm -rf/);
});
