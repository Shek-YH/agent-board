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
  assert.equal(event.event, 'profile_verified');
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
