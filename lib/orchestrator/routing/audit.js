'use strict';

const crypto = require('node:crypto');

const ROUTING_AUDIT_EVENTS = Object.freeze(new Set([
  'ROUTE_REQUESTED', 'ROUTE_RESOLVED', 'MODEL_CATALOG_REFRESHED',
  'MODEL_APPLY_STARTED', 'MODEL_APPLY_VERIFIED', 'MODEL_APPLY_FAILED',
  'REASONING_APPLY_VERIFIED', 'ROUTE_ESCALATED', 'ROUTE_DOWNGRADED',
  'ROUTE_FALLBACK', 'PROFILE_VERIFIED', 'PROFILE_PARTIAL', 'PROFILE_UNVERIFIED',
  'PROFILE_APPLY_STARTED', 'PROFILE_APPLY_FAILED',
]));

const EVENT_ALIASES = Object.freeze({
  routing_decision: 'ROUTE_RESOLVED',
  routing_skipped: 'ROUTE_FALLBACK',
  routing_unavailable: 'ROUTE_FALLBACK',
  profile_verified: 'PROFILE_VERIFIED',
  profile_verify_failed: 'PROFILE_UNVERIFIED',
  profile_partial: 'PROFILE_PARTIAL',
});

function text(value, max = 200) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex').slice(0, 16);
}

function code(value, max = 80) {
  return text(value, max).toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, max);
}

function normalizeAuditEventName(event) {
  const raw = text(event, 80);
  const upper = raw.toUpperCase();
  if (ROUTING_AUDIT_EVENTS.has(upper)) return upper;
  return EVENT_ALIASES[raw.toLowerCase()] || 'ROUTE_FALLBACK';
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
  const resultCode = code(profileResult && (profileResult.code || profileResult.reasonCode), 80);
  if (resultCode) profile.resultCode = resultCode;
  if (resolved.fallbackReason) profile.fallbackReason = text(resolved.fallbackReason, 300);
  const catalog = routeDecision.catalog || {};
  const routeFingerprint = fingerprint(JSON.stringify({ route, profile, catalog: { source: catalog.source, stale: catalog.stale } }));
  const canonicalEvent = normalizeAuditEventName(event);
  return {
    schemaVersion: 1,
    event: canonicalEvent,
    generatedAt: new Date(Number.isFinite(now) ? now : Date.now()).toISOString(),
    sessionFingerprint: fingerprint(sessionRef),
    fingerprint: routeFingerprint,
    route,
    profile,
    catalog: { source: text(catalog.source, 40), stale: catalog.stale === true },
  };
}

function normalizeRoutingAuditEvent(event, defaults = {}) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
  const route = event.route && typeof event.route === 'object' ? event.route : {};
  const profile = event.profile && typeof event.profile === 'object' ? event.profile : {};
  const catalog = event.catalog && typeof event.catalog === 'object' ? event.catalog : {};
  const routeDecision = event.route || event.profile || event.catalog ? {
    enabled: route.enabled === true,
    action: route.action,
    reasonCode: route.reasonCode,
    routeRequest: {
      complexityTier: route.complexityTier,
      thinkingTier: route.thinkingTier,
      promptPolicy: route.promptPolicy,
    },
    resolvedProfile: {
      modelId: profile.modelId,
      reasoningLevel: profile.reasoningLevel,
      fallbackApplied: profile.fallbackApplied === true,
      fallbackReason: profile.fallbackReason,
    },
    catalog,
  } : (defaults.routeDecision || {});
  const profileResult = event.profile || defaults.profileResult ? {
    source: profile.source,
    verified: profile.verified === true,
    fallbackApplied: profile.fallbackApplied === true,
    readback: { modelId: profile.modelId, reasoningLevel: profile.reasoningLevel },
    code: profile.resultCode,
  } : null;
  return buildRoutingAuditEvent({
    event: normalizeAuditEventName(event.canonicalEvent || event.event),
    sessionRef: defaults.sessionRef || '',
    routeDecision,
    profileResult,
    now: defaults.now,
  });
}

module.exports = {
  ROUTING_AUDIT_EVENTS, buildRoutingAuditEvent, normalizeAuditEventName,
  normalizeRoutingAuditEvent, fingerprint,
};
