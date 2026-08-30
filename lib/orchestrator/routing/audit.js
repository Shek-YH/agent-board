'use strict';

const crypto = require('node:crypto');

function text(value, max = 200) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex').slice(0, 16);
}

function buildRoutingAuditEvent({ event = 'routing_decision', sessionRef = '', routeDecision = {}, profileResult = null, now = Date.now() } = {}) {
  const request = routeDecision.routeRequest || {};
  const resolved = routeDecision.resolvedProfile || {};
  const route = {
    enabled: routeDecision.enabled === true,
    action: text(routeDecision.action, 30),
    reasonCode: text(routeDecision.reasonCode, 80),
    complexityTier: text(request.complexityTier, 10),
    thinkingTier: text(request.thinkingTier, 10),
    promptPolicy: text(request.promptPolicy, 10),
  };
  const profile = {
    modelId: text((profileResult && profileResult.readback && profileResult.readback.modelId) || resolved.modelId, 200),
    reasoningLevel: text((profileResult && profileResult.readback && profileResult.readback.reasoningLevel) || resolved.reasoningLevel, 30).toLowerCase(),
    source: text(profileResult && profileResult.source, 40),
    verified: profileResult ? profileResult.verified === true : false,
    fallbackApplied: Boolean((profileResult && profileResult.fallbackApplied) || resolved.fallbackApplied),
  };
  if (resolved.fallbackReason) profile.fallbackReason = text(resolved.fallbackReason, 300);
  const catalog = routeDecision.catalog || {};
  const routeFingerprint = fingerprint(JSON.stringify({ route, profile, catalog: { source: catalog.source, stale: catalog.stale } }));
  return {
    schemaVersion: 1,
    event: text(event, 80) || 'routing_decision',
    generatedAt: new Date(Number.isFinite(now) ? now : Date.now()).toISOString(),
    sessionFingerprint: fingerprint(sessionRef),
    fingerprint: routeFingerprint,
    route,
    profile,
    catalog: { source: text(catalog.source, 40), stale: catalog.stale === true },
  };
}

module.exports = { buildRoutingAuditEvent, fingerprint };
