'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildSupervisorReviewInput,
  generateSupervisorReview,
  parseSupervisorReview,
} = require('./supervisor-review');

function workflow() {
  return {
    runContract: {
      goal: '完成 C:\\Projects\\secret-app 的登录测试',
      scope: { inScope: ['src/auth'], outOfScope: ['部署', 'Git Push'] },
      verify: { dod: ['单元测试通过'] },
    },
    lastResult: { status: 'failed', stdout: 'token=should-not-leak', stderr: 'C:\\Projects\\secret-app\\error.log' },
  };
}

test('Supervisor review parser accepts only the constrained JSON shape', () => {
  const review = parseSupervisorReview('```json\n{"decision":"DONE","summary":"已验证","dodChecks":[{"index":0,"status":"pass","reason":"测试通过"}]}\n```');
  assert.deepEqual(review, {
    decision: 'DONE', summary: '已验证',
    dodChecks: [{ index: 0, status: 'pass', reason: '测试通过' }],
  });
  assert.throws(() => parseSupervisorReview('{"decision":"DONE","command":"npm test"}'), /未知字段/);
  assert.throws(() => parseSupervisorReview('{"decision":"RUN"}'), /decision 无效/);
});

test('Supervisor review input redacts project paths and secret-like values', () => {
  const input = buildSupervisorReviewInput({
    workflow: workflow(),
    progress: { status: 'in_progress', completed: 0, total: 1, evidence: [] },
    session: { messages: [{ role: 'user', text: '请检查 token=abc123 和 C:\\Projects\\secret-app\\src' }] },
  });
  const serialized = JSON.stringify(input);
  assert.doesNotMatch(serialized, /abc123|C:\\Projects\\secret-app/);
  assert.match(serialized, /REDACTED|LOCAL_PROJECT_PATH/);
});

test('Supervisor review calls the configured ZAI model and returns a safe structured result', async () => {
  let request;
  const result = await generateSupervisorReview({
    workflow: workflow(), progress: { status: 'completed', completed: 1, total: 1, evidence: [] }, session: { messages: [] },
    env: { ZAI_API_KEY: 'secret-api-key', model: 'glm-test' },
    fetchImpl: async (endpoint, options) => {
      request = { endpoint, options };
      return { ok: true, json: async () => ({ choices: [{ message: { content: '{"decision":"DONE","summary":"通过","dodChecks":[{"index":0,"status":"pass","reason":"ok"}]}' } }] }) };
    },
  });
  assert.equal(result.source, 'model');
  assert.equal(result.provider, 'zai');
  assert.equal(result.model, 'glm-test');
  assert.equal(result.review.decision, 'DONE');
  assert.match(request.endpoint, /bigmodel\.cn/);
  assert.match(request.options.headers.Authorization, /secret-api-key/);
  assert.doesNotMatch(request.options.body, /C:\\Projects\\secret-app|secret-api-key/);
});

test('Supervisor review fails closed to deterministic mode on invalid model output', async () => {
  const result = await generateSupervisorReview({
    workflow: workflow(), progress: { status: 'in_progress', evidence: [] }, session: { messages: [] },
    env: { ZAI_API_KEY: 'secret-api-key', model: 'glm-test' },
    fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '{"decision":"RUN"}' } }] }) }),
  });
  assert.equal(result.source, 'deterministic');
  assert.equal(result.review, null);
  assert.match(result.warning, /回退到确定性 Supervisor/);
  assert.doesNotMatch(result.warning, /secret-api-key/);
});
