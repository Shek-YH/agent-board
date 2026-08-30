'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { evaluatePolicyGate } = require('./policy-gate');

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
