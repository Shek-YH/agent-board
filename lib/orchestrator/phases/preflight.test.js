'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { runPreflightSession } = require('./preflight');

test('preflight phase resolves, enriches, and verifies the bound session', async () => {
  const calls = [];
  const workflow = {
    agent: 'codex',
    binding: { sessionRef: 'codex:session-1', projectPath: 'C:\\Projects\\demo', title: 'Bound title' },
  };
  const result = await runPreflightSession({
    workflow,
    dependencies: {
      resolveSession: async (request, context) => {
        calls.push(['resolve', request, context]);
        return {
          status: 'resolved',
          target: { sessionRef: request.sessionRef, agent: request.agent, project: request.project, role: 'main', controlEligibility: 'eligible' },
          candidates: [{ sessionRef: request.sessionRef, agent: request.agent, project: request.project, role: 'main', controlEligibility: 'eligible' }],
        };
      },
      verifySession: async (target, context) => {
        calls.push(['verify', target, context]);
        return { strongAnchor: true, anchor: 'verified-anchor' };
      },
    },
  });
  assert.equal(result.strongAnchor, true);
  assert.equal(result.anchor, 'verified-anchor');
  assert.equal(calls.length, 2);
  assert.equal(calls[0][2].phase, 'PREFLIGHT');
  assert.equal(calls[1][2].phase, 'PREFLIGHT');
});

test('preflight phase fails closed when the binding or verification is unavailable', async () => {
  assert.equal(await runPreflightSession({ workflow: { binding: {} }, dependencies: {} }), null);
  assert.equal(await runPreflightSession({
    workflow: { agent: 'codex', binding: { sessionRef: 'codex:s1', projectPath: 'C:\\Projects\\demo' } },
    dependencies: { resolveSession: async () => ({ candidates: [] }), verifySession: async () => ({ strongAnchor: true }) },
  }), null);
});
