'use strict';

const SSE_PROTOCOL_VERSION = 1;

class SseSequence {
  constructor(start = 0) {
    this.value = Number.isSafeInteger(start) && start >= 0 ? start : 0;
  }

  next(type, payload, at = Date.now()) {
    this.value += 1;
    return {
      version: SSE_PROTOCOL_VERSION,
      seq: this.value,
      eventId: String(this.value),
      type,
      at,
      payload,
    };
  }
}

function formatSseEvent(envelope) {
  if (!envelope || envelope.version !== SSE_PROTOCOL_VERSION || !Number.isSafeInteger(envelope.seq)) {
    throw new TypeError('Invalid SSE envelope');
  }
  return `id: ${envelope.eventId}\nevent: ${envelope.type}\ndata: ${JSON.stringify(envelope)}\n\n`;
}

function parseSseEnvelope(raw) {
  const payload = JSON.parse(raw);
  if (!payload || payload.version !== SSE_PROTOCOL_VERSION || !Number.isSafeInteger(payload.seq)) {
    return { envelope: null, payload };
  }
  return { envelope: payload, payload: payload.payload };
}

module.exports = { SSE_PROTOCOL_VERSION, SseSequence, formatSseEvent, parseSseEnvelope };
