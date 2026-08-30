'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { dispatchVerifiedMessage } = require('./verified-dispatch');

function resolvedTarget(overrides = {}) {
  return {
    sessionRef: 'codex:session-1',
    agent: 'codex',
    project: 'C:/repo',
    role: 'main',
    controlEligibility: 'eligible',
    ...overrides,
  };
}

function baseDeps(overrides = {}) {
  return {
    resolveSession: async () => ({ status: 'resolved', target: resolvedTarget() }),
    verifySession: async () => ({ ok: true, strongAnchor: true, anchor: 'session-1' }),
    activateSession: async () => ({ ok: true, action: 'activated' }),
    writer: {
      write: async () => ({ ok: true, draft: 'written' }),
      send: async () => ({ ok: true, sent: true }),
    },
    verifyDraft: async () => ({ ok: true, matches: true }),
    verifyDelivery: async () => ({ ok: true, delivered: true }),
    ...overrides,
  };
}

function phaseNames(result) {
  return result.phases.map((item) => item.phase);
}

test('rejects an empty message before resolving or writing', async () => {
  let resolveCalls = 0;
  let writeCalls = 0;
  const result = await dispatchVerifiedMessage(
    { agent: 'codex', sessionRef: 'codex:session-1', message: '   ' },
    baseDeps({
      resolveSession: async () => { resolveCalls++; return { status: 'resolved', target: resolvedTarget() }; },
      writer: {
        write: async () => { writeCalls++; return { ok: true }; },
        send: async () => ({ ok: true }),
      },
    }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.failure.code, 'EMPTY_MESSAGE');
  assert.equal(result.phase, 'PREPARE');
  assert.equal(resolveCalls, 0);
  assert.equal(writeCalls, 0);
});

test('fails closed when the session locator returns no session', async () => {
  let writeCalls = 0;
  const result = await dispatchVerifiedMessage(
    { agent: 'codex', sessionRef: 'codex:missing', message: 'hello' },
    baseDeps({
      resolveSession: async () => ({ status: 'not_found', reason: 'missing' }),
      writer: {
        write: async () => { writeCalls++; return { ok: true }; },
        send: async () => ({ ok: true }),
      },
    }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.failure.code, 'SESSION_NOT_RESOLVED');
  assert.equal(result.phase, 'RESOLVE_SESSION');
  assert.equal(writeCalls, 0);
});

test('rejects a request without an explicit session or project locator', async () => {
  let resolveCalls = 0;
  let writeCalls = 0;
  const result = await dispatchVerifiedMessage(
    { agent: 'codex', message: 'hello' },
    baseDeps({
      resolveSession: async () => { resolveCalls++; return { status: 'resolved', target: resolvedTarget() }; },
      writer: {
        write: async () => { writeCalls++; return { ok: true }; },
        send: async () => ({ ok: true }),
      },
    }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.failure.code, 'MISSING_TARGET_LOCATOR');
  assert.equal(result.phase, 'PREPARE');
  assert.equal(resolveCalls, 0);
  assert.equal(writeCalls, 0);
});

test('rejects resolved child and non-eligible targets before activation', async () => {
  for (const target of [
    resolvedTarget({ role: 'child', controlEligibility: 'blocked' }),
    resolvedTarget({ controlEligibility: 'manual_only' }),
  ]) {
    let activateCalls = 0;
    let writeCalls = 0;
    const result = await dispatchVerifiedMessage(
      { agent: 'codex', sessionRef: 'codex:session-1', message: 'hello' },
      baseDeps({
        resolveSession: async () => ({ status: 'resolved', target }),
        activateSession: async () => { activateCalls++; return { ok: true }; },
        writer: {
          write: async () => { writeCalls++; return { ok: true }; },
          send: async () => ({ ok: true }),
        },
      }),
    );

    assert.equal(result.ok, false);
    assert.equal(result.failure.code, 'TARGET_NOT_ELIGIBLE');
    assert.equal(result.phase, 'RESOLVE_SESSION');
    assert.equal(activateCalls, 0);
    assert.equal(writeCalls, 0);
  }
});

test('blocks child sessions and ambiguous locator results before activation', async () => {
  for (const resolution of [
    { status: 'blocked', reason: 'child session' },
    { status: 'ambiguous', candidates: [resolvedTarget(), resolvedTarget({ sessionRef: 'codex:session-2' })] },
  ]) {
    let activateCalls = 0;
    let writeCalls = 0;
    const result = await dispatchVerifiedMessage(
      { agent: 'codex', project: 'C:/repo', message: 'hello' },
      baseDeps({
        resolveSession: async () => resolution,
        activateSession: async () => { activateCalls++; return { ok: true }; },
        writer: {
          write: async () => { writeCalls++; return { ok: true }; },
          send: async () => ({ ok: true }),
        },
      }),
    );

    assert.equal(result.ok, false);
    assert.equal(result.failure.code, 'SESSION_NOT_RESOLVED');
    assert.equal(result.phase, 'RESOLVE_SESSION');
    assert.equal(activateCalls, 0);
    assert.equal(writeCalls, 0);
  }
});

test('re-verifies the strong session anchor after activation and stops on drift', async () => {
  let verifyCalls = 0;
  let writeCalls = 0;
  const result = await dispatchVerifiedMessage(
    { agent: 'codex', sessionRef: 'codex:session-1', message: 'hello' },
    baseDeps({
      verifySession: async () => {
        verifyCalls++;
        return verifyCalls === 1
          ? { ok: true, strongAnchor: true, anchor: 'session-1' }
          : { ok: false, strongAnchor: false, reason: 'different session' };
      },
      writer: {
        write: async () => { writeCalls++; return { ok: true }; },
        send: async () => ({ ok: true }),
      },
    }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.failure.code, 'IDENTITY_DRIFT');
  assert.equal(result.phase, 'RE_VERIFY_SESSION');
  assert.equal(verifyCalls, 2);
  assert.equal(writeCalls, 0);
});

test('stops before writing when eligibility drifts after activation', async () => {
  let resolveCalls = 0;
  let writeCalls = 0;
  const result = await dispatchVerifiedMessage(
    { agent: 'codex', sessionRef: 'codex:session-1', message: 'hello' },
    baseDeps({
      resolveSession: async () => {
        resolveCalls++;
        return {
          status: 'resolved',
          target: resolvedTarget(resolveCalls === 1 ? {} : { controlEligibility: 'blocked' }),
        };
      },
      writer: {
        write: async () => { writeCalls++; return { ok: true }; },
        send: async () => ({ ok: true }),
      },
    }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.failure.code, 'TARGET_NOT_ELIGIBLE');
  assert.equal(result.phase, 'RE_VERIFY_SESSION');
  assert.equal(writeCalls, 0);
});

test('does not overwrite an existing user draft', async () => {
  let sendCalls = 0;
  const result = await dispatchVerifiedMessage(
    { agent: 'codex', sessionRef: 'codex:session-1', message: 'hello' },
    baseDeps({
      writer: {
        write: async () => ({ ok: false, code: 'DRAFT_PRESENT', reason: 'user draft exists' }),
        send: async () => { sendCalls++; return { ok: true }; },
      },
    }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.failure.code, 'DRAFT_PRESENT');
  assert.equal(result.phase, 'WRITE');
  assert.equal(sendCalls, 0);
});

test('runs the complete lifecycle exactly once and commits only after delivery evidence', async () => {
  const calls = [];
  const result = await dispatchVerifiedMessage(
    { agent: 'codex', sessionRef: 'codex:session-1', message: 'hello' },
    baseDeps({
      resolveSession: async () => { calls.push('resolve'); return { status: 'resolved', target: resolvedTarget() }; },
      verifySession: async () => { calls.push('verify'); return { ok: true, strongAnchor: true, anchor: 'session-1' }; },
      activateSession: async () => { calls.push('activate'); return { ok: true }; },
      writer: {
        write: async () => { calls.push('write'); return { ok: true }; },
        send: async () => { calls.push('send'); return { ok: true, sent: true }; },
      },
      verifyDraft: async () => { calls.push('draft'); return { ok: true, matches: true }; },
      verifyDelivery: async () => { calls.push('delivery'); return { ok: true, delivered: true }; },
    }),
  );

  assert.equal(result.ok, true);
  assert.equal(result.status, 'committed');
  assert.deepEqual(calls, ['resolve', 'verify', 'activate', 'resolve', 'verify', 'write', 'draft', 'send', 'delivery']);
  assert.deepEqual(phaseNames(result), [
    'PREPARE', 'LOCK', 'RESOLVE_SESSION', 'VERIFY_SESSION', 'ACTIVATE',
    'RE_VERIFY_SESSION', 'WRITE', 'VERIFY_DRAFT', 'SEND', 'VERIFY_DELIVERY', 'COMMIT',
  ]);
});

test('returns reconciliation_required after send without retrying', async () => {
  let sendCalls = 0;
  let deliveryCalls = 0;
  const result = await dispatchVerifiedMessage(
    { agent: 'codex', sessionRef: 'codex:session-1', message: 'hello' },
    baseDeps({
      writer: {
        write: async () => ({ ok: true }),
        send: async () => { sendCalls++; return { ok: true, sent: true }; },
      },
      verifyDelivery: async () => { deliveryCalls++; return { ok: false, delivered: false, reason: 'not visible yet' }; },
    }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.status, 'reconciliation_required');
  assert.equal(result.reconciliationRequired, true);
  assert.equal(result.failure.code, 'DELIVERY_UNVERIFIED');
  assert.equal(sendCalls, 1);
  assert.equal(deliveryCalls, 1);
  assert.equal(result.phases.filter((item) => item.phase === 'SEND').length, 1);
  assert.equal(result.phases.some((item) => item.phase === 'RETRY'), false);
});

test('treats a returned send failure as reconciliation without retrying', async () => {
  let sendCalls = 0;
  const result = await dispatchVerifiedMessage(
    { agent: 'codex', sessionRef: 'codex:session-1', message: 'hello' },
    baseDeps({
      writer: {
        write: async () => ({ ok: true }),
        send: async () => { sendCalls++; return { ok: false, code: 'SEND_FAILED', reason: 'transport timeout' }; },
      },
    }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.status, 'reconciliation_required');
  assert.equal(result.reconciliationRequired, true);
  assert.equal(result.phase, 'SEND');
  assert.equal(sendCalls, 1);
});

test('does not send when draft verification fails', async () => {
  let sendCalls = 0;
  const result = await dispatchVerifiedMessage(
    { agent: 'codex', sessionRef: 'codex:session-1', message: 'hello' },
    baseDeps({
      writer: {
        write: async () => ({ ok: true }),
        send: async () => { sendCalls++; return { ok: true }; },
      },
      verifyDraft: async () => ({ ok: false, matches: false, reason: 'readback drift' }),
    }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.failure.code, 'DRAFT_MISMATCH');
  assert.equal(result.phase, 'VERIFY_DRAFT');
  assert.equal(sendCalls, 0);
});

test('does not send when the writer reports a mismatched immediate readback', async () => {
  let sendCalls = 0;
  const result = await dispatchVerifiedMessage(
    { agent: 'codex', sessionRef: 'codex:session-1', message: 'hello' },
    baseDeps({
      writer: {
        write: async () => ({ ok: true, matches: false, reason: 'immediate readback drift' }),
        send: async () => { sendCalls++; return { ok: true }; },
      },
    }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.failure.code, 'DRAFT_MISMATCH');
  assert.equal(result.phase, 'WRITE');
  assert.equal(sendCalls, 0);
});

test('requires a concrete strong session anchor before writing', async () => {
  let writeCalls = 0;
  const result = await dispatchVerifiedMessage(
    { agent: 'codex', sessionRef: 'codex:session-1', message: 'hello' },
    baseDeps({
      verifySession: async () => ({ ok: true, strongAnchor: true }),
      writer: {
        write: async () => { writeCalls++; return { ok: true }; },
        send: async () => ({ ok: true }),
      },
    }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.failure.code, 'SESSION_IDENTITY_UNVERIFIED');
  assert.equal(result.phase, 'VERIFY_SESSION');
  assert.equal(writeCalls, 0);
});

test('serializes dispatches for the same agent and session', async () => {
  const order = [];
  let releaseFirst;
  const firstWriteEntered = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let writeCalls = 0;
  const deps = baseDeps({
    writer: {
      write: async () => {
        writeCalls++;
        order.push(`write-${writeCalls}`);
        if (writeCalls === 1) await firstWriteEntered;
        return { ok: true };
      },
      send: async () => { order.push('send'); return { ok: true }; },
    },
  });
  const first = dispatchVerifiedMessage(
    { agent: 'codex', sessionRef: 'codex:session-1', message: 'first' },
    deps,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['write-1']);

  const second = dispatchVerifiedMessage(
    { agent: 'codex', sessionRef: 'codex:session-1', message: 'second' },
    deps,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['write-1']);

  releaseFirst();
  const results = await Promise.all([first, second]);
  assert.equal(results.every((item) => item.ok), true);
  assert.deepEqual(order, ['write-1', 'send', 'write-2', 'send']);
});

test('captures one delivery boundary before writing and passes it to delivery verification', async () => {
  const calls = [];
  const snapshot = { agent: 'codex', filePath: 'session.jsonl', byteOffset: 10 };
  const result = await dispatchVerifiedMessage(
    { agent: 'codex', sessionRef: 'codex:session-1', message: 'hello' },
    baseDeps({
      captureDeliverySnapshot: async () => { calls.push('snapshot'); return snapshot; },
      writer: {
        write: async () => { calls.push('write'); return { ok: true }; },
        send: async () => { calls.push('send'); return { ok: true }; },
      },
      verifyDelivery: async (target, message, context) => {
        calls.push(context.snapshot === snapshot ? 'delivery-with-snapshot' : 'delivery-without-snapshot');
        return { ok: true, delivered: true };
      },
    }),
  );

  assert.equal(result.ok, true);
  assert.deepEqual(calls, ['snapshot', 'write', 'send', 'delivery-with-snapshot']);
  assert.deepEqual(result.evidence.DELIVERY_SNAPSHOT, snapshot);
});

test('enriches the strict resolver target before activation and writing', async () => {
  const seen = [];
  const target = resolvedTarget({ agent: undefined, project: undefined, controlEligibility: undefined });
  const result = await dispatchVerifiedMessage(
    { agent: 'codex', project: 'C:/repo', sessionRef: 'codex:session-1', message: 'hello' },
    baseDeps({
      resolveSession: async () => ({
        status: 'resolved',
        target: { sessionRef: 'codex:session-1', role: 'main' },
        candidates: [{
          sessionRef: target.sessionRef,
          agent: 'codex',
          project: 'C:/repo',
          role: 'main',
          controlEligibility: 'eligible',
        }],
      }),
      verifySession: async (actual) => { seen.push(['verify', actual]); return { ok: true, strongAnchor: true, anchor: 'session-1' }; },
      activateSession: async (actual) => { seen.push(['activate', actual]); return { ok: true }; },
      writer: {
        write: async (actual) => { seen.push(['write', actual]); return { ok: true }; },
        send: async () => ({ ok: true }),
      },
    }),
  );

  assert.equal(result.ok, true);
  assert.equal(seen.every(([, actual]) => actual.agent === 'codex' && actual.project === 'C:/repo'), true);
});

test('serializes the same session even when requests use different locators', async () => {
  const order = [];
  let releaseFirst;
  const firstWriteEntered = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let writeCalls = 0;
  const deps = baseDeps({
    writer: {
      write: async () => {
        writeCalls++;
        order.push(`write-${writeCalls}`);
        if (writeCalls === 1) await firstWriteEntered;
        return { ok: true };
      },
      send: async () => { order.push('send'); return { ok: true }; },
    },
  });
  const first = dispatchVerifiedMessage(
    { agent: 'codex', sessionRef: 'codex:session-1', message: 'first' },
    deps,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['write-1']);

  const second = dispatchVerifiedMessage(
    { agent: 'codex', project: 'C:/repo', message: 'second' },
    deps,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['write-1']);

  releaseFirst();
  const results = await Promise.all([first, second]);
  assert.equal(results.every((item) => item.ok), true);
  assert.deepEqual(order, ['write-1', 'send', 'write-2', 'send']);
});
