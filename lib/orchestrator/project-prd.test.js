'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { findProjectPrd, generatePrdGoalDraft } = require('./project-prd');

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
