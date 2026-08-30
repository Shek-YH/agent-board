'use strict';

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function expectedProfile(profile) {
  return {
    modelId: text(profile && profile.modelId),
    reasoningLevel: text(profile && profile.reasoningLevel).toLowerCase(),
  };
}

function verifyReadback(profile, readback) {
  const expected = expectedProfile(profile);
  const actual = expectedProfile(readback);
  if (!expected.modelId || !expected.reasoningLevel) {
    return { ok: false, code: 'INVALID_PROFILE', reason: 'execution profile is incomplete' };
  }
  if (expected.modelId !== actual.modelId || expected.reasoningLevel !== actual.reasoningLevel) {
    return {
      ok: false,
      code: 'PROFILE_VERIFY_FAILED',
      reason: 'session readback does not exactly match the requested profile',
      expected,
      actual,
    };
  }
  return { ok: true, expected, actual };
}

async function applyWithCapability(capability, { sessionRef, profile }) {
  if (!capability || typeof capability.applyProfile !== 'function') {
    return { ok: false, code: 'PROFILE_APPLY_UNAVAILABLE', dispatchAllowed: false };
  }
  let applied;
  try {
    applied = await capability.applyProfile({ sessionRef, profile });
  } catch (error) {
    return {
      ok: false,
      code: error && error.code === 'SESSION_DRIFT' ? 'SESSION_DRIFT' : 'PROFILE_APPLY_FAILED',
      error: error instanceof Error ? error.message : String(error || 'profile apply failed'),
      dispatchAllowed: false,
    };
  }

  let readback = applied && applied.readback ? applied.readback : applied;
  if (!readback && typeof capability.readProfile === 'function') {
    try {
      readback = await capability.readProfile({ sessionRef });
    } catch (error) {
      return {
        ok: false,
        code: error && error.code === 'SESSION_DRIFT' ? 'SESSION_DRIFT' : 'PROFILE_VERIFY_FAILED',
        error: error instanceof Error ? error.message : String(error || 'profile readback failed'),
        dispatchAllowed: false,
      };
    }
  }
  const verification = verifyReadback(profile, readback);
  if (!verification.ok) return { ...verification, source: applied && applied.source, dispatchAllowed: false };
  return {
    ...applied,
    ok: true,
    source: (applied && applied.source) || capability.name || 'unknown',
    readback,
    verified: true,
    dispatchAllowed: true,
  };
}

async function applyAndVerifyProfile({ native, fallback, allowFallback = false, sessionRef, profile } = {}) {
  const expected = expectedProfile(profile);
  if (!expected.modelId || !expected.reasoningLevel) {
    return { ok: false, code: 'INVALID_PROFILE', dispatchAllowed: false };
  }

  const nativeResult = await applyWithCapability(native, { sessionRef, profile });
  if (nativeResult.ok) return nativeResult;
  if (nativeResult.code === 'PROFILE_VERIFY_FAILED' || nativeResult.code === 'SESSION_DRIFT') return nativeResult;

  if (allowFallback && fallback && typeof fallback.applyProfile === 'function') {
    const fallbackResult = await applyWithCapability(fallback, { sessionRef, profile });
    if (fallbackResult.ok) return { ...fallbackResult, fallbackApplied: true };
    return fallbackResult;
  }
  return nativeResult.code === 'PROFILE_APPLY_UNAVAILABLE'
    ? nativeResult
    : { ...nativeResult, dispatchAllowed: false };
}

module.exports = { applyAndVerifyProfile, verifyReadback };
