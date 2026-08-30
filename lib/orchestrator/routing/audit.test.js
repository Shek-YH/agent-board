'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildRoutingAuditEvent } = require('./audit');

test('builds a safe routing audit summary without prompt or token data', () => {
  const event = buildRoutingAuditEvent({
    event: 'profile_verified',
    sessionRef: 'codex:11111111-1111-4111-8111-111111111111',
    routeDecision: {
      enabled: true,
      action: 'apply',
      reasonCode: 'ROUTE_ESCALATED',
      routeRequest: { complexityTier: 'C2', thinkingTier: 'T2', promptPolicy: 'P1' },
      resolvedProfile: { modelId: 'gpt-5.6-sol', reasoningLevel: 'high', fallbackApplied: false },
      catalog: { source: 'native', stale: false },
    },
    profileResult: { source: 'native', verified: true, readback: { modelId: 'gpt-5.6-sol', reasoningLevel: 'high' } },
    now: 1_700_000_000_000,
  });

  assert.equal(event.schemaVersion, 1);
  assert.equal(event.event, 'PROFILE_VERIFIED');
  assert.match(event.sessionFingerprint, /^[a-f0-9]{16}$/);
  assert.deepEqual(event.route, {
    enabled: true, action: 'apply', reasonCode: 'ROUTE_ESCALATED',
    complexityTier: 'C2', thinkingTier: 'T2', promptPolicy: 'P1',
  });
  assert.deepEqual(event.profile, {
    modelId: 'gpt-5.6-sol', reasoningLevel: 'high', source: 'native', verified: true,
    fallbackApplied: false,
  });
  assert.deepEqual(event.catalog, { source: 'native', stale: false });
  assert.equal(Object.prototype.hasOwnProperty.call(event, 'prompt'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(event, 'token'), false);
  assert.equal(JSON.stringify(event).includes('11111111-1111-4111-8111-111111111111'), false);
});

test('normalizes routing and profile audit aliases to safe canonical events', () => {
  const failed = buildRoutingAuditEvent({
    event: 'profile_verify_failed',
    sessionRef: 'session-secret',
    routeDecision: {
      enabled: true,
      action: 'apply',
      reasonCode: 'ROUTE_ESCALATED',
      routeRequest: { complexityTier: 'C2', thinkingTier: 'T2', promptPolicy: 'P1' },
      resolvedProfile: { modelId: 'strong', reasoningLevel: 'high' },
    },
    profileResult: { code: 'PROFILE_VERIFY_FAILED', error: 'token=do-not-persist' },
  });
  const unknown = buildRoutingAuditEvent({
    event: 'arbitrary_internal_event',
    routeDecision: { enabled: true, action: 'continue', reasonCode: 'ROUTING_UNAVAILABLE' },
  });

  const normalizedFailed = require('./audit').normalizeRoutingAuditEvent(failed);
  const normalizedUnknown = require('./audit').normalizeRoutingAuditEvent(unknown);
  assert.equal(normalizedFailed.event, 'PROFILE_UNVERIFIED');
  assert.equal(normalizedUnknown.event, 'ROUTE_FALLBACK');
  assert.equal(JSON.stringify(failed).includes('token=do-not-persist'), false);
  assert.equal(JSON.stringify(failed).includes('session-secret'), false);
  assert.match(failed.profile.resultCode, /^[A-Z0-9_]+$/);
});
