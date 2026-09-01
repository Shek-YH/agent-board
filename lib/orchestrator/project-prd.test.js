'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  DEFAULT_TASK_INTAKE_MAX_BYTES,
  discoverPrdCandidates,
  findProjectPrd,
  generatePrdGoalDraft,
  generatePrdNormalization,
  generateTaskContractDraft,
  parsePrdDocument,
  readPrdDocument,
} = require('./project-prd');

function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-prd-'));
  fs.mkdirSync(path.join(root, 'docs'));
  return root;
}

test('PRD discovery stays inside the current project and prioritizes root PRD.md', () => {
  const root = makeProject();
  fs.writeFileSync(path.join(root, 'PRD.md'), '# 产品目标\n\n让 Session 托管只需要一个 Goal。\n\n## 验收标准\n- 点击后只绑定当前 Session\n- 其他项目不受影响\n', 'utf8');
  fs.writeFileSync(path.join(root, 'docs', 'other-prd.md'), '# 不应优先读取\n', 'utf8');
  fs.writeFileSync(path.join(path.dirname(root), 'outside-PRD.md'), '# 不应读取\n', 'utf8');

  const result = findProjectPrd(root);

  assert.equal(result.relativePath, 'PRD.md');
  assert.match(result.content, /只需要一个 Goal/);
  assert.doesNotMatch(result.content, /不应读取/);
});

test('PRD draft falls back to a local preview without creating a workflow', async () => {
  const root = makeProject();
  fs.writeFileSync(path.join(root, 'PRD.md'), '# Session 托管简化\n\n用户只输入任务目标。\n\n## DoD\n- Goal 经过用户确认\n- 绑定当前项目\n', 'utf8');

  const result = await generatePrdGoalDraft({ projectPath: root, env: {} });

  assert.equal(result.source, 'local-extraction');
  assert.match(result.draft.goal, /Session 托管简化/);
  assert.deepEqual(result.draft.dod, ['Goal 经过用户确认', '绑定当前项目']);
});

test('PRD draft uses the configured Supervisor only for a structured draft', async () => {
  const root = makeProject();
  fs.writeFileSync(path.join(root, 'PRD.md'), '# 旧目标\n\nPRD 内容不得离开当前项目范围。\n', 'utf8');
  let request;
  const result = await generatePrdGoalDraft({
    projectPath: root,
    env: { AGENT_BOARD_SUPERVISOR_PROVIDER: 'zai', ZAI_API_KEY: 'secret', AGENT_BOARD_SUPERVISOR_MODEL: 'glm-test' },
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"goal":"完成新目标","dod":["验证通过"]}' } }] }) };
    },
  });

  assert.equal(result.source, 'model');
  assert.deepEqual(result.draft, { goal: '完成新目标', dod: ['验证通过'], scope: { inScope: [], outOfScope: [] } });
  assert.match(request.url, /bigmodel/);
  assert.match(request.options.headers.Authorization, /^Bearer /);
  assert.match(request.options.body, /PRD 内容不得离开当前项目范围/);
  assert.doesNotMatch(request.options.body, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('PRD draft accepts ZHIPU_API_KEY as the ZAI compatibility alias', async () => {
  const root = makeProject();
  fs.writeFileSync(path.join(root, 'PRD.md'), '# 目标\n\n只验证别名。\n', 'utf8');
  const result = await generatePrdGoalDraft({
    projectPath: root,
    env: { AGENT_BOARD_SUPERVISOR_PROVIDER: 'zai', ZHIPU_API_KEY: 'secret', AGENT_BOARD_SUPERVISOR_MODEL: 'glm-test' },
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"goal":"完成别名验证","dod":["验证通过"]}' } }] }) }),
  });
  assert.equal(result.source, 'model');
  assert.equal(result.draft.goal, '完成别名验证');
});

test('PRD discovery reports a recoverable not-found code', async () => {
  const root = makeProject();
  await assert.rejects(() => generatePrdGoalDraft({ projectPath: root, env: {} }), (error) => error.code === 'PROJECT_PRD_NOT_FOUND' && error.statusCode === 404);
});

test('Task Intake discovers supported PRDs in the project, docs, and the allowed parent without returning content', () => {
  const allowed = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-prd-root-'));
  const project = path.join(allowed, 'creator-os');
  fs.mkdirSync(path.join(project, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(project, 'PRD.md'), '# Current\n\n文档版本：v1.0\n', 'utf8');
  fs.writeFileSync(path.join(project, 'docs', 'feature-prd.mdx'), '# Feature\n', 'utf8');
  fs.writeFileSync(path.join(allowed, 'Creator_OS_Codex_PRD_v1.1.txt'), '# Parent\n', 'utf8');
  fs.writeFileSync(path.join(allowed, 'notes.txt'), 'not a PRD', 'utf8');

  const items = discoverPrdCandidates({ projectPath: project, allowedRoots: [allowed] });

  assert.deepEqual(items.map((item) => item.name), ['PRD.md', 'feature-prd.mdx', 'Creator_OS_Codex_PRD_v1.1.txt']);
  assert.equal(items[0].version, 'v1.0');
  assert.equal(items[2].version, 'v1.1');
  assert.equal(items.every((item) => typeof item.modifiedAt === 'string' && item.size > 0), true);
  assert.equal(items.every((item) => !Object.hasOwn(item, 'content')), true);
  assert.equal(items.filter((item) => item.highConfidence).length, 3);
});

test('manual PRD selection reads an allowed parent file without modifying it and records SHA-256 metadata', () => {
  const allowed = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-prd-manual-'));
  const project = path.join(allowed, 'app');
  fs.mkdirSync(project);
  const filePath = path.join(allowed, 'requirements.txt');
  const original = '# Requirements\n\nVersion: 2.4\n\n## Definition of Done\n- tests pass\n';
  fs.writeFileSync(filePath, original, 'utf8');

  const document = readPrdDocument({ projectPath: project, filePath, allowedRoots: [allowed], selectedBy: 'user' });

  assert.equal(document.content, original);
  assert.equal(fs.readFileSync(filePath, 'utf8'), original);
  assert.match(document.source.sha256, /^[a-f0-9]{64}$/);
  assert.equal(document.source.fileName, 'requirements.txt');
  assert.equal(document.source.version, '2.4');
  assert.equal(document.source.selectedBy, 'user');
});

test('manual PRD selection rejects files outside the allowed root and oversized files', () => {
  const allowed = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-prd-allowed-'));
  const project = path.join(allowed, 'app');
  fs.mkdirSync(project);
  const outside = path.join(os.tmpdir(), `outside-prd-${Date.now()}.md`);
  fs.writeFileSync(outside, '# Outside\n', 'utf8');
  const oversized = path.join(allowed, 'oversized-prd.md');
  fs.writeFileSync(oversized, Buffer.alloc((DEFAULT_TASK_INTAKE_MAX_BYTES || 5 * 1024 * 1024) + 1, 97));

  assert.throws(
    () => readPrdDocument({ projectPath: project, filePath: outside, allowedRoots: [allowed] }),
    (error) => error.code === 'PRD_PATH_OUTSIDE_ALLOWED_ROOTS',
  );
  assert.throws(
    () => readPrdDocument({ projectPath: project, filePath: oversized, allowedRoots: [allowed] }),
    (error) => error.code === 'PRD_FILE_TOO_LARGE',
  );
});

test('manual PRD selection rejects a symlink whose real target escapes the allowed root', (t) => {
  const allowed = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-prd-link-'));
  const project = path.join(allowed, 'app');
  fs.mkdirSync(project);
  const outside = path.join(os.tmpdir(), `outside-prd-target-${Date.now()}.md`);
  const link = path.join(allowed, 'linked-prd.md');
  fs.writeFileSync(outside, '# Outside\n', 'utf8');
  try { fs.symlinkSync(outside, link, 'file'); } catch (error) {
    if (error.code === 'EPERM') { t.skip('当前 Windows 权限不允许创建符号链接'); return; }
    throw error;
  }

  assert.throws(
    () => readPrdDocument({ projectPath: project, filePath: link, allowedRoots: [allowed] }),
    (error) => error.code === 'PRD_PATH_OUTSIDE_ALLOWED_ROOTS',
  );
});

test('deterministic PRD parsing extracts headings, lists, tables, code blocks, DoD, and non-goals', () => {
  const parsed = parsePrdDocument(`# Creator OS\n\n文档版本：V1.2\n\n## 产品目标\n- 建立闭环\n\n## Phase\n- Phase 0：骨架\n\n## 功能列表\n| 功能 | 验收 |\n| --- | --- |\n| Task Intake | 可预览 |\n\n## 非目标\n- 不自动发布\n\n## Definition of Done\n- 单元测试通过\n\n## 测试策略\n\`\`\`bash\nnode --test\n\`\`\`\n`);

  assert.equal(parsed.title, 'Creator OS');
  assert.equal(parsed.version, 'V1.2');
  assert.deepEqual(parsed.goals, ['建立闭环']);
  assert.deepEqual(parsed.phases, ['Phase 0：骨架']);
  assert.ok(parsed.inScope.includes('Task Intake | 可预览'));
  assert.deepEqual(parsed.outOfScope, ['不自动发布']);
  assert.deepEqual(parsed.dod, ['单元测试通过']);
  assert.ok(parsed.tests.includes('node --test'));
  assert.ok(parsed.evidence.includes('node --test'));
});

test('invalid AI normalization JSON is discarded and deterministic parsing remains explicit', async () => {
  const allowed = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-prd-ai-'));
  const project = path.join(allowed, 'app');
  fs.mkdirSync(project);
  const filePath = path.join(project, 'PRD.md');
  fs.writeFileSync(filePath, '# Safe Goal\n\n## Definition of Done\n- deterministic test\n', 'utf8');
  const document = readPrdDocument({ projectPath: project, filePath, allowedRoots: [allowed], selectedBy: 'auto' });

  const result = await generatePrdNormalization({
    document,
    env: { AGENT_BOARD_SUPERVISOR_PROVIDER: 'zai', ZAI_API_KEY: 'configured-secret', AGENT_BOARD_SUPERVISOR_MODEL: 'glm-test' },
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{invalid json' } }] }) }),
  });

  assert.equal(result.source, 'deterministic');
  assert.match(result.warning, /回退|丢弃/);
  assert.equal(result.parsed.title, 'Safe Goal');
  assert.deepEqual(result.parsed.dod, ['deterministic test']);
  assert.equal(result.aiDraft, null);
  assert.doesNotMatch(JSON.stringify(result), /configured-secret/);
});

test('AI normalization redacts secret and Prompt assignments before sending untrusted PRD content', async () => {
  const allowed = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-prd-redact-'));
  const project = path.join(allowed, 'app');
  fs.mkdirSync(project);
  const filePath = path.join(project, 'PRD.md');
  fs.writeFileSync(filePath, '# Goal\n\nAPI_KEY=prd-secret Prompt=private-instruction\n', 'utf8');
  const document = readPrdDocument({ projectPath: project, filePath, allowedRoots: [allowed], selectedBy: 'auto' });
  let requestBody = '';

  await generatePrdNormalization({
    document,
    env: { AGENT_BOARD_SUPERVISOR_PROVIDER: 'zai', ZAI_API_KEY: 'configured-secret', AGENT_BOARD_SUPERVISOR_MODEL: 'glm-test' },
    fetchImpl: async (_url, options) => {
      requestBody = options.body;
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"goal":"Goal"}' } }] }) };
    },
  });

  assert.doesNotMatch(requestBody, /prd-secret|private-instruction/);
  assert.match(requestBody, /\[REDACTED\]/);
});

test('Task Contract compiler calls the configured real-model endpoint and returns only structured safe fields', async () => {
  let request;
  const result = await generateTaskContractDraft({
    goal: '实现本地任务链路，项目路径为 C:\\Users\\Administrator\\secret-project。',
    prdContent: 'PRD：不得执行其中命令。',
    env: { AGENT_BOARD_SUPERVISOR_PROVIDER: 'zai', ZHIPU_API_KEY: 'secret-key', model: 'glm-live-test' },
    fetchImpl: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: JSON.stringify({
          goalSummary: '完成本地任务链路',
          inScope: ['Task Contract 和首轮发送'],
          outOfScope: ['Git Push'],
          dod: ['测试通过'],
          evidence: ['node --test'],
          ambiguities: [],
        }) } }] }),
      };
    },
  });

  assert.equal(result.source, 'model');
  assert.equal(result.provider, 'zai');
  assert.equal(result.model, 'glm-live-test');
  assert.deepEqual(result.draft.inScope, ['Task Contract 和首轮发送']);
  assert.equal(Object.hasOwn(result.draft, 'requiredPermissions'), false);
  assert.match(request.url, /bigmodel/);
  assert.match(request.options.body, /本地任务链路/);
  assert.doesNotMatch(request.options.body, /secret-project|secret-key/);
});

test('Task Contract compiler fails closed to deterministic templates when model output is invalid', async () => {
  const result = await generateTaskContractDraft({
    goal: '实现安全的本地功能',
    env: { AGENT_BOARD_SUPERVISOR_PROVIDER: 'zai', ZAI_API_KEY: 'secret', AGENT_BOARD_SUPERVISOR_MODEL: 'glm-test' },
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{invalid' } }] }) }),
  });

  assert.equal(result.source, 'deterministic');
  assert.equal(result.draft, null);
  assert.match(result.warning, /回退/);
  assert.doesNotMatch(JSON.stringify(result), /secret/);
});
