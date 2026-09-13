'use strict';

const { normalizeEvidence } = require('./evidence');
const { CANONICAL_DIMENSIONS } = require('./enums');
const { DEFAULT_SOURCE_AUTHORITY_POLICY } = require('./policies/default');
const { CODEX_SOURCE_AUTHORITY_POLICY } = require('./policies/codex');
const { WORKBUDDY_SOURCE_AUTHORITY_POLICY } = require('./policies/workbuddy');

const DIMENSIONS = new Set(Object.values(CANONICAL_DIMENSIONS));

function policyAuthority(policy, dimension, evidence) {
  const configured = policy && policy.authority && policy.authority[dimension];
  if (configured && configured[evidence.source] !== undefined) return configured[evidence.source];
  return evidence.authority;
}

function isExpired(policy, evidence, now) {
  if (evidence.expiresAt !== undefined) return now >= evidence.expiresAt;
  const ttl = policy && policy.ttlMs && policy.ttlMs[evidence.source];
  return Number.isFinite(ttl) && now - evidence.observedAt >= ttl;
}

function compareCandidates(left, right) {
  const fields = [
    (item) => item.effectiveAuthority,
    (item) => item.evidence.sourceGeneration ?? -1,
    (item) => item.evidence.sourceSequence ?? -1,
    (item) => item.evidence.occurredAt,
    (item) => item.evidence.observedAt,
  ];
  for (const getValue of fields) {
    const difference = getValue(right) - getValue(left);
    if (difference !== 0) return difference;
  }
  return String(left.evidence.evidenceId).localeCompare(String(right.evidence.evidenceId));
}

function ignoreReason(candidate, winner) {
  if (candidate.expired) return 'expired';
  if (candidate.effectiveAuthority < winner.effectiveAuthority) return 'lower_authority';
  return 'older_tiebreaker';
}

function arbitrateEvidence(dimension, candidates, options = {}) {
  if (!DIMENSIONS.has(dimension)) throw new TypeError(`unsupported canonical dimension: ${dimension}`);
  if (!Array.isArray(candidates)) throw new TypeError('candidates must be an array');
  const policy = options.policy || DEFAULT_SOURCE_AUTHORITY_POLICY;
  const now = Number(options.now ?? Date.now());
  if (!Number.isFinite(now) || now < 0) throw new TypeError('now must be a non-negative finite number');

  const evaluated = candidates.map((input) => {
    const evidence = normalizeEvidence(input);
    return {
      evidence,
      effectiveAuthority: policyAuthority(policy, dimension, evidence),
      expired: isExpired(policy, evidence, now),
    };
  });
  const available = evaluated.filter((candidate) => !candidate.expired).sort(compareCandidates);
  const winner = available[0] ? available[0].evidence : null;
  const ignored = evaluated.filter((candidate) => candidate.evidence !== winner).map((candidate) => ({
    evidenceId: candidate.evidence.evidenceId,
    reason: winner ? ignoreReason(candidate, available[0]) : 'expired',
  }));
  return {
    winner,
    winnerAuthority: winner ? available[0].effectiveAuthority : null,
    ignored,
    conflicts: ignored.map((item) => ({ dimension, ...item })),
  };
}

module.exports = {
  arbitrateEvidence,
  DEFAULT_SOURCE_AUTHORITY_POLICY,
  CODEX_SOURCE_AUTHORITY_POLICY,
  WORKBUDDY_SOURCE_AUTHORITY_POLICY,
};
