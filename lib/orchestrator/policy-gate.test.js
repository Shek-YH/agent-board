'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { evaluatePolicyGate } = require('./policy-gate');
const { buildPermissionSnapshot, normalizePermissionSnapshot } = require('./permission-snapshot');

function workflow(fields = {}) {
  return {
    autopilotMode: 'auto',
    projectPath: 'C:\\Projects\\demo',
    binding: { sessionRef: 'session-1', agent: 'codex', projectPath: 'C:\\Projects\\demo' },
    controlOwner: 'autopilot',
    runContract: { scope: { inScope: [], outOfScope: ['deploy'] } },
    ...fields,
  };
}

const capabilities = {
  sessionIdentity: true,
  completionDetector: true,
  messageWriter: true,
  deliveryVerifier: true,
  verifiedDispatch: true,
};

test('policy gate permits a bound eligible single-session dispatch', () => {
  const result = evaluatePolicyGate({
    workflow: workflow(), capabilities,
    session: { strongAnchor: true, sessionRef: 'session-1', agent: 'codex', project: 'C:\\Projects\\demo', role: 'main', controlEligibility: 'eligible' },
    instruction: '修复测试', watchdog: { allowed: true },
  });
  assert.equal(result.allowed, true);
  assert.equal(result.checks.every((item) => item.status === 'pass'), true);
});

test('policy gate does not treat supervisor safety prohibitions as active secret or network operations', () => {
  const result = evaluatePolicyGate({
    workflow: workflow(), capabilities,
    session: { strongAnchor: true, sessionRef: 'session-1', agent: 'codex', project: 'C:\\Projects\\demo', role: 'main', controlEligibility: 'eligible' },
    instruction: '继续完成目标：修复测试\n范围内：src\n范围外：不读取或输出密钥、Token、密码和完整 .env 内容；不执行 Git Push\n当前未完成 DoD：测试通过\n完成后请提供 Evidence，不要执行范围外操作。',
    watchdog: { allowed: true },
  });
  assert.equal(result.allowed, true);
});

test('policy gate fails closed for missing identity, human control, dangerous instruction, and duplicate', () => {
  const base = { workflow: workflow(), capabilities, watchdog: { allowed: true }, instruction: '修复测试' };
  const session = { strongAnchor: true, sessionRef: 'session-1', agent: 'codex', project: 'C:\\Projects\\demo', role: 'main', controlEligibility: 'eligible' };
  assert.equal(evaluatePolicyGate({ ...base, session: null }).reasonCode, 'IDENTITY_UNVERIFIED');
  assert.equal(evaluatePolicyGate({ ...base, workflow: workflow({ controlOwner: 'human' }), session: { strongAnchor: true } }).reasonCode, 'NEED_HUMAN');
  assert.equal(evaluatePolicyGate({ ...base, instruction: 'git push origin main', session }).reasonCode, 'PERMISSION_REQUIRED');
  assert.equal(evaluatePolicyGate({ ...base, watchdog: { allowed: false, reason: 'Duplicate Instruction' }, session }).reasonCode, 'DUPLICATE_INSTRUCTION');
});

test('policy gate rejects a binding outside the workflow project scope', () => {
  const result = evaluatePolicyGate({
    workflow: workflow({ binding: { sessionRef: 'session-1', agent: 'codex', projectPath: 'C:\\Projects\\other' } }),
    capabilities, allowedRoots: ['C:\\Projects'],
    session: { strongAnchor: true, sessionRef: 'session-1', agent: 'codex', project: 'C:\\Projects\\other', role: 'main', controlEligibility: 'eligible' },
    instruction: '修复测试', watchdog: { allowed: true },
  });
  assert.equal(result.reasonCode, 'SCOPE_INVALID');
});

test('policy gate enters NEED_HUMAN when the immutable permission snapshot no longer covers the binding', () => {
  const snapshot = normalizePermissionSnapshot({ projectPath: 'C:\\Projects\\other' });
  const result = evaluatePolicyGate({
    workflow: workflow({ permissionSnapshot: snapshot }),
    capabilities, allowedRoots: ['C:\\Projects'],
    session: { strongAnchor: true, sessionRef: 'session-1', agent: 'codex', project: 'C:\\Projects\\demo', role: 'main', controlEligibility: 'eligible' },
    instruction: '修复测试', watchdog: { allowed: true },
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reasonCode, 'NEED_HUMAN_SCOPE');
});

test('policy gate keeps Git Push human-only even when a snapshot records the requested capability', () => {
  const snapshot = buildPermissionSnapshot({ projectPath: 'C:\\Projects\\demo', settings: { safety: { allowGitPush: true } } });
  const result = evaluatePolicyGate({
    workflow: workflow({ permissionSnapshot: snapshot }), capabilities,
    session: { strongAnchor: true, sessionRef: 'session-1', agent: 'codex', project: 'C:\\Projects\\demo', role: 'main', controlEligibility: 'eligible' },
    instruction: 'git push origin main', watchdog: { allowed: true }, allowedRoots: ['C:\\Projects'],
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reasonCode, 'PERMISSION_REQUIRED');
});

test('policy gate only allows network instructions for domains in the permission snapshot', () => {
  const snapshot = buildPermissionSnapshot({
    projectPath: 'C:\\Projects\\demo',
    settings: { safety: { allowNetwork: true, allowedNetworkDomains: ['example.com'] } },
  });
  const base = {
    workflow: workflow({ permissionSnapshot: snapshot }), capabilities,
    session: { strongAnchor: true, sessionRef: 'session-1', agent: 'codex', project: 'C:\\Projects\\demo', role: 'main', controlEligibility: 'eligible' },
    watchdog: { allowed: true }, allowedRoots: ['C:\\Projects'],
  };
  assert.equal(evaluatePolicyGate({ ...base, instruction: '请求 https://api.example.com/data' }).allowed, true);
  assert.equal(evaluatePolicyGate({ ...base, instruction: '请求 https://evil.example.net/data' }).reasonCode, 'PERMISSION_REQUIRED');
});
