'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { enrichVerifiedTarget } = require('./verified-dispatch-target');

test('enriches the strict resolver target with the matching agent and project candidate', () => {
  const result = enrichVerifiedTarget(
    { agent: 'codex', project: 'C:/repo', sessionRef: 'codex:thread-1' },
    {
      status: 'resolved',
      target: { sessionRef: 'codex:thread-1', role: 'main' },
      candidates: [{
        sessionRef: 'codex:thread-1',
        agent: 'codex',
        project: 'C:/repo',
        title: 'POC session',
        role: 'main',
        controlEligibility: 'eligible',
      }],
    },
  );

  assert.deepEqual(result, {
    sessionRef: 'codex:thread-1',
    role: 'main',
    agent: 'codex',
    project: 'C:/repo',
    title: 'POC session',
    controlEligibility: 'eligible',
  });
});

test('does not enrich a resolved target from a candidate belonging to another request', () => {
  const result = enrichVerifiedTarget(
    { agent: 'hermes', project: 'C:/repo', sessionRef: 'hermes:session-1' },
    {
      status: 'resolved',
      target: { sessionRef: 'hermes:session-1', role: 'main' },
      candidates: [{
        sessionRef: 'hermes:session-1',
        agent: 'codex',
        project: 'C:/repo',
        role: 'main',
        controlEligibility: 'eligible',
      }],
    },
  );

  assert.equal(result, null);
});

test('preserves an already enriched target when the resolver omits candidates', () => {
  const target = {
    sessionRef: 'codex:thread-1',
    role: 'main',
    agent: 'codex',
    project: 'C:/repo',
    controlEligibility: 'eligible',
  };
  assert.deepEqual(
    enrichVerifiedTarget(
      { agent: 'codex', project: 'C:/repo', sessionRef: 'codex:thread-1' },
      { status: 'resolved', target },
    ),
    target,
  );
});
