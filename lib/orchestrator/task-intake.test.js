'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  buildTaskContract,
  classifyTask,
  normalizeTaskContract,
  previewTaskIntake,
  validateTaskContract,
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

test('normalized research keeps bounded unresolved questions without raw source material', () => {
  const contract = normalizeTaskContract({
    goal: '研究项目并完成任务',
    classification: { kind: 'standard', confidence: 0.62 },
    research: {
      status: 'completed', confidence: 0.8,
      unresolvedQuestions: ['是否允许读取外部资料', 'password=secret'],
      sources: [{ kind: 'local', path: 'README.md', title: 'README', content: 'raw source must not persist' }],
    },
    unresolvedQuestions: ['需要确认验收标准'],
  });

  assert.deepEqual(contract.unresolvedQuestions, ['需要确认验收标准']);
  assert.doesNotMatch(JSON.stringify(contract), /raw source must not persist|password=secret/);
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

test('hosted intake auto-generates a complete contract from a simple goal without PRD', () => {
  const contract = buildTaskContract({
    goal: '修改登录页按钮文案，并补充相关单元测试。',
    autoGenerate: true,
  });

  assert.equal(contract.classification.complexity, 'simple');
  assert.equal(contract.classification.riskLevel, 'low');
  assert.equal(contract.goal, '修改登录页按钮文案，并补充相关单元测试。');
  assert.ok(contract.inScope.length > 0);
  assert.ok(contract.outOfScope.length >= 6);
  assert.ok(contract.dod.length > 0);
  assert.ok(contract.evidence.length > 0);
  assert.ok(contract.assumptions.length > 0);
  assert.deepEqual(contract.requiredPermissions, []);
  assert.equal(contract.generationSources.goal, 'user_goal');
  assert.equal(contract.generationSources.inScope, 'user_goal');
  assert.equal(contract.generationSources.dod, 'inferred');
  assert.equal(contract.generationSources.evidence, 'inferred');
  assert.equal(contract.sourceSummary, 'goal-only');
  assert.equal(contract.requiresHumanConfirmation, true);
});

test('hosted intake parses PRD multiline fields and keeps PRD priority over inferred values', () => {
  const contract = buildTaskContract({
    goal: '实现登录模块并补充测试。',
    autoGenerate: true,
    source: { fileName: 'Product_PRD.md', version: 'v1.0', selectedBy: 'user' },
    prd: {
      inScope: '- 登录页面\n- 登录 API\n- 登录页面',
      outOfScope: '* 真实短信发送',
      dod: '1. 页面可以提交\n2. 页面可以提交',
      evidence: '- node --test\n- npm test',
    },
  });

  assert.deepEqual(contract.inScope, ['登录页面', '登录 API']);
  assert.deepEqual(contract.outOfScope.slice(0, 2), ['真实短信发送', '不删除用户数据']);
  assert.deepEqual(contract.dod, ['页面可以提交']);
  assert.deepEqual(contract.evidence.slice(0, 2), ['node --test', 'npm test']);
  assert.equal(contract.generationSources.inScope, 'prd');
  assert.equal(contract.generationSources.dod, 'prd');
});

test('hosted intake separates complexity from critical risk and keeps dangerous permissions gated', () => {
  const contract = buildTaskContract({
    goal: '删除生产数据库中的用户数据，然后直接发布到线上。',
    autoGenerate: true,
  });

  assert.equal(contract.classification.complexity, 'standard');
  assert.ok(['high', 'critical'].includes(contract.classification.riskLevel));
  assert.ok(contract.classification.riskReasons.length >= 2);
  assert.ok(contract.requiredPermissions.length >= 2);
  assert.equal(contract.humanGate.required, true);
  assert.equal(contract.requiresHumanConfirmation, true);
  assert.ok(contract.outOfScope.length > 0);
  assert.ok(contract.dod.length > 0);
  assert.ok(contract.evidence.length > 0);
});

test('low-confidence contracts require research instead of becoming NEED_HUMAN by themselves', () => {
  const contract = buildTaskContract({ goal: '完成目标但不说明要改什么或如何验收。', autoGenerate: true });
  const result = validateTaskContract({ contract });

  assert.equal(result.valid, false);
  assert.equal(result.needsHuman, false);
  assert.equal(result.researchRequired, true);
  assert.equal(result.code, 'TASK_CONTRACT_INCOMPLETE');
  assert.equal(result.missingFields.length, 0);
  assert.equal(contract.inScope.length > 0, true);
  assert.equal(contract.dod.length > 0, true);
  assert.equal(contract.evidence.length > 0, true);
  assert.ok(result.reasons.length > 0);
  assert.ok(result.suggestedActions.length > 0);
});

test('preview uses an injected read-only researcher to resolve low-confidence fields before confirmation', async () => {
  let researchCalls = 0;
  const preview = await previewTaskIntake({
    projectPath: process.cwd(), goal: '完成目标但不说明要改什么或如何验收。', prdMode: 'none',
    env: {}, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ choices: [] }) }),
    researcher: {
      research: async ({ fields }) => {
        researchCalls += 1;
        assert.ok(fields.includes('inScope'));
        return {
          status: 'completed', confidence: 0.91, confidenceLevel: 'high',
          sources: [{ kind: 'local', path: 'README.md', title: 'README' }],
          findings: {
            inScope: ['本地任务入口'],
            dod: ['node --test 通过'],
            evidence: ['node --test 输出和变更文件清单'],
          },
          assumptions: ['只读取当前项目文档'], unresolvedQuestions: [],
        };
      },
    },
  });
  assert.equal(researchCalls, 1);
  assert.equal(preview.analysis.research.status, 'completed');
  assert.equal(preview.taskContract.generationStatus, 'ready');
  assert.equal(preview.taskContract.confidenceLevel, 'high');
  assert.equal(preview.analysis.validation.valid, true);
  assert.equal(preview.analysis.validation.needsHuman, false);
});

test('validation rejects invalid generation sources and unapproved external side effects', () => {
  const contract = buildTaskContract({ goal: '把内容真实发布到小红书', autoGenerate: true });
  const invalidSource = validateTaskContract({
    contract: { ...contract, generationSources: { goal: 'model_output' } },
  });
  assert.equal(invalidSource.valid, false);
  assert.ok(invalidSource.reasons.some((reason) => /来源/.test(reason)));

  const unapproved = validateTaskContract({
    contract,
    permissionSnapshot: { allowExternalSideEffects: false, allowGitPush: false },
  });
  assert.equal(unapproved.valid, false);
  assert.ok(unapproved.permissionViolations.some((permission) => /外部发布/.test(permission)));
});

test('safety prohibitions in a multi-round prompt do not become requested permissions', () => {
  const contract = buildTaskContract({
    goal: [
      '- [ ] Phase 1：完成本地任务模型和测试',
      '- [ ] Phase 2：增加状态筛选和稳定排序',
    '- 不联网、不下载、不上传',
    '- 禁止部署和 Git Push。',
    '- 不安装依赖，不执行 Git Push，不读取 .env',
    ].join('\n'),
    autoGenerate: true,
  });

  assert.equal(contract.classification.riskLevel, 'low');
  assert.deepEqual(contract.requiredPermissions, []);
  assert.equal(validateTaskContract({
    contract,
    permissionSnapshot: { allowNetwork: false, allowInstall: false, allowGitPush: false, allowSecrets: false },
  }).valid, true);
});

test('security policy documentation in a development prompt does not become requested permissions', () => {
  const contract = buildTaskContract({
    goal: [
      '实现本地 AutoPilot 任务链路并补充测试。',
      '必须遵守：',
      '- 不自动安装依赖。',
      '- 不部署、不发布、不 Git push。',
      '## 默认安全边界',
      '- 不删除用户数据。',
      '如果用户明确要求这些危险操作：',
      '1. 加入 requiredPermissions；',
      '2. 不得直接执行。',
      '以下情况必须进入 NEED_HUMAN：',
      '- 访问项目目录之外；',
      '- 安装未授权依赖；',
      '- 执行 Git Push；',
      '- 发送外部消息。',
    ].join('\n'),
    autoGenerate: true,
  });

  assert.equal(contract.classification.riskLevel, 'low');
  assert.deepEqual(contract.requiredPermissions, []);
});

test('risk checklists and UI flow descriptions do not become requested permissions', () => {
  const contract = buildTaskContract({
    goal: [
      '实现本地 AutoPilot 任务链路并补充测试。',
      '### 6.2 风险因素',
      '至少检查：',
      '- 删除、覆盖、迁移或清理数据；',
      '- 网络访问；',
      '- 依赖安装；',
      '- Git commit、push、部署或发布；',
      '- 密钥、Token、密码、.env 或用户数据；',
      '- 跨项目目录访问；',
      '- 外部消息或不可逆副作用；',
      '- 无法验证结果的操作；',
      '输出值：low、medium、high、critical。',
      '### 用户流程',
      '配置 AutoPilot 和权限，点击分析目标并生成 Task Contract。',
    ].join('\n'),
    autoGenerate: true,
  });

  assert.equal(contract.classification.riskLevel, 'low');
  assert.deepEqual(contract.requiredPermissions, []);
});

test('AI compiler fields are merged into the confirmed contract without granting permissions', () => {
  const contract = buildTaskContract({
    goal: '完成本地任务链路',
    autoGenerate: true,
    aiDraft: {
      goalSummary: '完成本地任务链路并验证结果',
      inScope: ['任务入口', '首轮发送'],
      outOfScope: ['部署'],
      dod: ['node --test 通过'],
      evidence: ['测试结果和变更文件清单'],
      risks: ['不得扩大项目目录'],
      assumptions: ['只操作用户选择的项目'],
      requiredPermissions: ['Git Push'],
    },
  });

  assert.equal(contract.goalSummary, '完成本地任务链路并验证结果');
  assert.deepEqual(contract.inScope, ['任务入口', '首轮发送']);
  assert.deepEqual(contract.dod, ['node --test 通过']);
  assert.equal(contract.generationSources.inScope, 'model');
  assert.deepEqual(contract.requiredPermissions, []);
  assert.equal(contract.sourceSummary, 'goal+model+safety');
});

test('preview intake invokes the configured model before a session can be created', async () => {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-task-intake-'));
  let requestCount = 0;
  try {
    const preview = await previewTaskIntake({
      projectPath,
      goal: '实现本地任务入口并补充测试',
      prdMode: 'none',
      env: { ZHIPU_API_KEY: 'test-only-key', model: 'glm-test' },
      fetchImpl: async () => {
        requestCount += 1;
        return {
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content: JSON.stringify({
            goalSummary: '完成本地任务入口并通过测试',
            inScope: ['任务入口'],
            outOfScope: ['部署'],
            dod: ['测试通过'],
            evidence: ['node --test'],
            ambiguities: [],
          }) } }] }),
        };
      },
    });

    assert.equal(requestCount, 1);
    assert.equal(preview.analysis.taskCompiler.source, 'model');
    assert.equal(preview.taskContract.goalSummary, '完成本地任务入口并通过测试');
    assert.deepEqual(preview.taskContract.inScope, ['任务入口']);
    assert.equal(preview.analysis.validation.valid, true);
  } finally {
    fs.rmSync(projectPath, { recursive: true, force: true });
  }
});

test('ordinary AI ambiguities become assumptions instead of blocking the hosted workflow', () => {
  const contract = buildTaskContract({
    goal: '实现本地任务入口并补充测试',
    autoGenerate: true,
    aiDraft: {
      goalSummary: '完成本地任务入口并通过测试',
      inScope: ['任务入口'], outOfScope: ['部署'], dod: ['测试通过'], evidence: ['测试结果'],
      ambiguities: ['未说明测试框架'],
    },
  });
  assert.equal(contract.needsHumanReason, '');
  assert.equal(contract.humanGate.state, '');
});

test('AI ambiguities about safety boundaries still enter NEED_HUMAN', () => {
  const contract = buildTaskContract({
    goal: '实现本地任务入口并补充测试',
    autoGenerate: true,
    aiDraft: {
      goalSummary: '完成本地任务入口并通过测试',
      inScope: ['任务入口'], outOfScope: ['部署'], dod: ['测试通过'], evidence: ['测试结果'],
      ambiguities: ['是否允许访问项目目录之外的文件'],
    },
  });
  assert.match(contract.needsHumanReason, /安全边界/);
  assert.equal(contract.humanGate.state, 'NEED_HUMAN');
});

test('fully user-specified contracts are not forced into research or NEED_HUMAN by low LLM confidence', () => {
  const contract = buildTaskContract({
    goal: '在当前项目里分三步交付一个小工具：第一步创建 step1.md（用中文写 3 段说明这个项目是做什么的）；第二步创建 step2.py（打印 hello agent-board）并运行 python 验证输出；第三步创建 step3.md 汇总前两步。',
    autoGenerate: true,
    aiDraft: {
      goalSummary: '分三步创建 step1.md + step2.py + step3.md 并验证',
      inScope: ['创建 step1.md 并写入至少 3 段中文项目说明', '创建 step2.py 并运行 python 验证输出 hello agent-board', '创建 step3.md 汇总前两步'],
      outOfScope: ['不执行 git push', '不访问项目目录之外'],
      dod: ['step1.md 存在且内容包含至少 3 段中文项目说明', 'step2.py 存在且运行 python 后输出包含 hello agent-board', 'step3.md 存在且汇总了 step1 与 step2'],
      evidence: ['读取 step1.md 统计段落数确认 >= 3 段', '运行 python step2.py 检查 stdout 包含 hello agent-board', '读取 step3.md 确认包含前两步摘要'],
      ambiguities: ['是否需要联网查询资料'],
    },
  });
  // 完整合同 + 仅「联网」这类日常歧义 → 不强制只读研究、不需要人工确认。
  assert.equal(contract.needsHumanReason, '');
  assert.equal(contract.humanGate.state, '');
  assert.equal(contract.generationStatus, 'ready');
  assert.equal(contract.research.status, 'not_started');
  assert.equal(contract.researchableFields.length, 0);
  const result = validateTaskContract({ contract });
  assert.equal(result.researchRequired, false);
});
