'use strict';

const { normalizeEvidence } = require('./evidence');

const MAX_TRACKED_EVIDENCE_IDS = 4096;

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
}

function freeze(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const item of Object.values(value)) freeze(item, seen);
  return Object.freeze(value);
}

function sourceKey(evidence) {
  return `${String(evidence.agent)}:${String(evidence.sessionRef)}:${String(evidence.source)}`;
}

function emptyWatermark() {
  return { generation: null, lastSequence: null, lastOffset: null, lastObservedAt: null };
}

function createSourceWatermarks(initial = {}) {
  const sources = {};
  for (const [key, value] of Object.entries(initial.sources || {})) {
    sources[key] = { ...emptyWatermark(), ...clone(value) };
  }
  const acceptedEvidenceIds = Array.isArray(initial.acceptedEvidenceIds)
    ? initial.acceptedEvidenceIds.map((id) => String(id)).slice(-MAX_TRACKED_EVIDENCE_IDS)
    : [];
  return freeze({ sources, acceptedEvidenceIds });
}

function evidenceOffset(evidence) {
  const value = evidence && evidence.evidence && evidence.evidence.offset;
  if (value === undefined || value === null) return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new TypeError('evidence.offset must be a non-negative integer');
  return number;
}

function acceptEvidence(previous, input) {
  const state = createSourceWatermarks(previous);
  const evidence = normalizeEvidence(input);
  if (state.acceptedEvidenceIds.includes(evidence.evidenceId)) {
    return { accepted: false, reason: 'duplicate_evidence', state };
  }

  const key = sourceKey(evidence);
  const current = state.sources[key] || emptyWatermark();
  const generation = evidence.sourceGeneration ?? current.generation;
  const sequence = evidence.sourceSequence ?? null;
  const offset = evidenceOffset(evidence);
  if (current.generation !== null && generation !== null && generation < current.generation) {
    return { accepted: false, reason: 'stale_generation', state };
  }
  if (current.generation === generation && sequence !== null && current.lastSequence !== null && sequence <= current.lastSequence) {
    return { accepted: false, reason: 'out_of_order_sequence', state };
  }
  if (current.generation === generation && sequence === null && offset !== null && current.lastOffset !== null && offset <= current.lastOffset) {
    return { accepted: false, reason: 'out_of_order_offset', state };
  }

  const nextSources = clone(state.sources);
  nextSources[key] = {
    generation,
    lastSequence: current.generation === generation ? (sequence ?? current.lastSequence) : sequence,
    lastOffset: current.generation === generation ? (offset ?? current.lastOffset) : offset,
    lastObservedAt: current.lastObservedAt === null
      ? evidence.observedAt
      : Math.max(current.lastObservedAt, evidence.observedAt),
  };
  const acceptedEvidenceIds = [...state.acceptedEvidenceIds, evidence.evidenceId].slice(-MAX_TRACKED_EVIDENCE_IDS);
  return {
    accepted: true,
    evidence,
    reason: 'accepted',
    state: freeze({ sources: nextSources, acceptedEvidenceIds }),
  };
}

module.exports = { MAX_TRACKED_EVIDENCE_IDS, sourceKey, createSourceWatermarks, acceptEvidence };
