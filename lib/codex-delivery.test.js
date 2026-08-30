'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const THREAD_ID = '019e4751-d521-7290-9627-e501f3d7d2d3';
const TARGET = { agent: 'codex', sessionRef: `codex:${THREAD_ID}`, project: 'C:/repo' };
const BEFORE = '2026-08-30T10:00:00.000Z';
const SENT_AT = Date.parse('2026-08-30T10:01:00.000Z');

function fixtureFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-codex-delivery-'));
  const filePath = path.join(dir, `rollout-${THREAD_ID}.jsonl`);
  fs.writeFileSync(filePath, [
    JSON.stringify({ timestamp: BEFORE, type: 'session_meta', payload: { id: THREAD_ID, cwd: 'C:/repo' } }),
    JSON.stringify({ timestamp: '2026-08-30T10:00:30.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'old answer' }] } }),
    '',
  ].join('\n'));
  return { dir, filePath };
}

test('Codex delivery snapshot accepts only an appended user message from the same session', () => {
  const { captureCodexDeliverySnapshot, verifyCodexDelivery } = require('./codex-delivery');
  const fixture = fixtureFile();
  try {
    const snapshot = captureCodexDeliverySnapshot(TARGET, { filePath: fixture.filePath, now: SENT_AT - 1000 });
    fs.appendFileSync(fixture.filePath, JSON.stringify({
      timestamp: '2026-08-30T10:01:01.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: ' hello\r\nworld ' }] },
    }) + '\n');
    const result = verifyCodexDelivery(TARGET, 'hello\nworld', { snapshot, sentAt: SENT_AT });
    assert.equal(result.ok, true);
    assert.equal(result.delivered, true);
    assert.equal(result.sessionRef, TARGET.sessionRef);
    assert.equal(result.textLength, 'hello\nworld'.length);
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('Codex delivery ignores assistant rows and returns not found without a new user row', () => {
  const { captureCodexDeliverySnapshot, verifyCodexDelivery } = require('./codex-delivery');
  const fixture = fixtureFile();
  try {
    const snapshot = captureCodexDeliverySnapshot(TARGET, { filePath: fixture.filePath, now: SENT_AT - 1000 });
    fs.appendFileSync(fixture.filePath, JSON.stringify({
      timestamp: '2026-08-30T10:01:01.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'echo' }] },
    }) + '\n');
    const result = verifyCodexDelivery(TARGET, 'hello', { snapshot, sentAt: SENT_AT });
    assert.equal(result.ok, false);
    assert.equal(result.delivered, false);
    assert.equal(result.code, 'DELIVERY_NOT_FOUND');
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('Codex delivery normalizes the desktop transport escape before matching the intended text', () => {
  const { captureCodexDeliverySnapshot, verifyCodexDelivery } = require('./codex-delivery');
  const fixture = fixtureFile();
  try {
    const snapshot = captureCodexDeliverySnapshot(TARGET, { filePath: fixture.filePath, now: SENT_AT - 1000 });
    fs.appendFileSync(fixture.filePath, JSON.stringify({
      timestamp: '2026-08-30T10:01:01.000Z',
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'AGENT\\_BOARD\\_SLICE0' }] },
    }) + '\n');
    const result = verifyCodexDelivery(TARGET, 'AGENT_BOARD_SLICE0', { snapshot, sentAt: SENT_AT });
    assert.equal(result.ok, true);
    assert.equal(result.delivered, true);
    assert.equal(result.transportNormalized, true);
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('Codex delivery returns unknown when the source file is truncated or unreadable', () => {
  const { captureCodexDeliverySnapshot, verifyCodexDelivery } = require('./codex-delivery');
  const fixture = fixtureFile();
  try {
    const snapshot = captureCodexDeliverySnapshot(TARGET, { filePath: fixture.filePath, now: SENT_AT - 1000 });
    fs.writeFileSync(fixture.filePath, '');
    const result = verifyCodexDelivery(TARGET, 'hello', { snapshot, sentAt: SENT_AT });
    assert.equal(result.ok, false);
    assert.equal(result.unknown, true);
    assert.equal(result.code, 'DELIVERY_UNKNOWN');
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('Codex delivery reader exposes snapshot and verify functions for orchestration injection', () => {
  const { createCodexDeliveryReader } = require('./codex-delivery');
  const reader = createCodexDeliveryReader({ filePath: 'fixture.jsonl' });
  assert.equal(typeof reader.snapshot, 'function');
  assert.equal(typeof reader.verify, 'function');
});
