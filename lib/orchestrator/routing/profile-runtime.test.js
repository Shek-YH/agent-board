'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { applyAndVerifyProfile } = require('./profile-runtime');

const profile = { modelId: 'strong', reasoningLevel: 'high' };

test('uses native profile apply and does not call fallback after exact verification', async () => {
  let fallbackCalls = 0;
  const result = await applyAndVerifyProfile({
    native: {
      applyProfile: async () => ({
        readback: { modelId: 'strong', reasoningLevel: 'high' },
        source: 'native',
      }),
    },
    fallback: {
      applyProfile: async () => { fallbackCalls += 1; },
    },
    allowFallback: true,
    sessionRef: 'codex:11111111-1111-4111-8111-111111111111',
    profile,
  });

  assert.equal(result.ok, true);
  assert.equal(result.source, 'native');
  assert.equal(result.verified, true);
  assert.equal(fallbackCalls, 0);
});

test('blocks dispatch when native readback drifts from the requested profile', async () => {
  const result = await applyAndVerifyProfile({
    native: {
      applyProfile: async () => ({
        readback: { modelId: 'balanced', reasoningLevel: 'high' },
        source: 'native',
      }),
    },
    sessionRef: 'codex:11111111-1111-4111-8111-111111111111',
    profile,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'PROFILE_VERIFY_FAILED');
  assert.equal(result.dispatchAllowed, false);
});

test('uses an explicitly enabled UIA fallback only after native failure', async () => {
  const calls = [];
  const result = await applyAndVerifyProfile({
    native: {
      applyProfile: async () => {
        calls.push('native');
        throw new Error('app server unavailable');
      },
    },
    fallback: {
      applyProfile: async () => {
        calls.push('fallback');
        return { readback: profile, source: 'uia-fallback' };
      },
    },
    allowFallback: true,
    sessionRef: 'codex:11111111-1111-4111-8111-111111111111',
    profile,
  });

  assert.equal(result.ok, true);
  assert.equal(result.source, 'uia-fallback');
  assert.deepEqual(calls, ['native', 'fallback']);
});

test('does not use an implicit fallback and fails closed when native capability is unavailable', async () => {
  const result = await applyAndVerifyProfile({
    sessionRef: 'codex:11111111-1111-4111-8111-111111111111',
    profile,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'PROFILE_APPLY_UNAVAILABLE');
  assert.equal(result.dispatchAllowed, false);
});
