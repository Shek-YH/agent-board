'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { requestJson } = require('./api-client');

function response(status, body, statusText = '') {
  return { status, statusText, ok: status >= 200 && status < 300, text: async () => typeof body === 'string' ? body : JSON.stringify(body) };
}

test('requestJson 返回成功 JSON', async () => {
  const data = await requestJson('/api/state', { fetchImpl: async () => response(200, { ok: true }) });
  assert.deepEqual(data, { ok: true });
});

test('requestJson 把非 2xx 的服务端错误传给调用方', async () => {
  await assert.rejects(
    requestJson('/api/open-with', { fetchImpl: async () => response(400, { error: 'session 不存在' }) }),
    /session 不存在/,
  );
});

test('requestJson 可保留业务失败响应供调用方执行恢复逻辑', async () => {
  const data = await requestJson('/api/launch-agent', {
    allowFailure: true,
    fetchImpl: async () => response(200, { ok: false, recovery: { autoConfigureAvailable: true } }),
  });
  assert.equal(data.ok, false);
  assert.equal(data.recovery.autoConfigureAvailable, true);
});

test('requestJson 拒绝空响应和非法 JSON', async () => {
  await assert.rejects(requestJson('/api/state', { fetchImpl: async () => response(200, '') }), /没有返回 JSON/);
  await assert.rejects(requestJson('/api/state', { fetchImpl: async () => response(200, 'not-json') }), /不是有效 JSON/);
});

test('requestJson preserves a stable server error code and recovery metadata', async () => {
  await assert.rejects(
    requestJson('/api/orchestration/workflows/wf-1/run', {
      fetchImpl: async () => response(409, { ok: false, code: 'SUGGEST_ONLY', error: 'Suggest Mode', recovery: { action: 'suggest' } }),
    }),
    (error) => error && error.code === 'SUGGEST_ONLY' && error.status === 409 && error.recovery.action === 'suggest',
  );
});

test('requestJson 保留 Task Contract 的具体错误详情', async () => {
  await assert.rejects(
    requestJson('/api/orchestration/intake/confirm', {
      fetchImpl: async () => response(422, {
        ok: false,
        code: 'TASK_CONTRACT_INCOMPLETE',
        error: 'Task Contract 尚未完成',
        missingFieldLabels: ['完成标准（DoD）'],
        reasons: ['所需权限未包含在当前预授权范围：访问网络'],
        suggestedActions: ['调整安全策略或减少任务权限'],
        permissionViolations: ['访问网络'],
      }),
    }),
    (error) => error
      && error.code === 'TASK_CONTRACT_INCOMPLETE'
      && error.missingFieldLabels[0] === '完成标准（DoD）'
      && error.permissionViolations[0] === '访问网络'
      && error.suggestedActions[0].includes('安全策略'),
  );
});
