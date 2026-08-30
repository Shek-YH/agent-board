'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  CAPABILITY_NAMES,
  createCapabilitySet,
  createCapabilityRegistry,
} = require('./capability-layer');

const implementation = () => ({ ok: true });

function definitions(overrides = {}) {
  const base = Object.fromEntries(CAPABILITY_NAMES.map((name) => [name, {
    supported: false,
    implementation: null,
    source: 'unavailable',
    reason: name + ' is not connected',
  }]));
  base.sessionLocator = {
    supported: true,
    implementation,
    source: 'core',
  };
  return { ...base, ...overrides };
}

test('creates a complete immutable capability set and exposes supported values', () => {
  const set = createCapabilitySet('codex', definitions({
    messageWriter: {
      supported: true,
      implementation: { write: implementation, send: implementation },
      source: 'uia',
    },
  }));

  assert.equal(set.agentId, 'codex');
  assert.equal(set.has('sessionLocator'), true);
  assert.equal(set.get('sessionLocator').implementation, implementation);
  assert.equal(set.get('messageWriter').supported, true);
  assert.equal(set.has('unknown'), false);
  assert.equal(Object.isFrozen(set), true);
  assert.equal(Object.isFrozen(set.capabilities), true);
  assert.throws(() => { set.capabilities.sessionLocator = null; }, TypeError);
});

test('requires every known capability and rejects unknown names', () => {
  const missing = definitions();
  delete missing.completionDetector;
  assert.throws(() => createCapabilitySet('codex', missing), TypeError);

  assert.throws(() => createCapabilitySet('codex', {
    ...definitions(),
    extraCapability: {
      supported: false,
      implementation: null,
      source: 'unavailable',
      reason: 'not supported',
    },
  }), TypeError);
});

test('requires an implementation for supported capability and a reason for unsupported capability', () => {
  assert.throws(() => createCapabilitySet('codex', definitions({
    sessionLocator: {
      supported: true,
      implementation: null,
      source: 'core',
    },
  })), TypeError);

  assert.throws(() => createCapabilitySet('codex', definitions({
    sessionActivator: {
      supported: false,
      implementation: null,
      source: 'unavailable',
    },
  })), TypeError);

  assert.throws(() => createCapabilitySet('codex', definitions({
    sessionActivator: {
      supported: false,
      implementation,
      source: 'unavailable',
      reason: 'not supported',
    },
  })), TypeError);
});

test('reports safe capability metadata without exposing implementations', () => {
  const set = createCapabilitySet('codex', definitions());
  const report = set.report();

  assert.deepEqual(report, {
    agentId: 'codex',
    capabilities: Object.fromEntries(CAPABILITY_NAMES.map((name) => [name, {
      supported: name === 'sessionLocator',
      source: name === 'sessionLocator' ? 'core' : 'unavailable',
      ...(name === 'sessionLocator' ? {} : { reason: name + ' is not connected' }),
    }])),
  });
  assert.equal('implementation' in report.capabilities.sessionLocator, false);
  assert.equal('implementation' in report.capabilities.sessionActivator, false);
});

test('registers agents, rejects duplicates, and returns null for unknown agents', () => {
  const registry = createCapabilityRegistry([
    { agentId: 'codex', capabilities: definitions() },
    { agentId: 'hermes', capabilities: definitions() },
  ]);

  assert.equal(registry.has('codex'), true);
  assert.equal(registry.get('hermes').agentId, 'hermes');
  assert.equal(registry.get('missing'), null);
  assert.deepEqual(registry.list().map((item) => item.agentId), ['codex', 'hermes']);
  assert.deepEqual(registry.report().map((item) => item.agentId), ['codex', 'hermes']);
  assert.throws(() => createCapabilityRegistry([
    { agentId: 'codex', capabilities: definitions() },
    { agentId: 'codex', capabilities: definitions() },
  ]), TypeError);
});

test('does not retain a mutable definitions object or expose implementation through reports', () => {
  const input = definitions();
  const registry = createCapabilityRegistry([{ agentId: 'codex', capabilities: input }]);
  input.sessionLocator.source = 'tampered';
  input.sessionLocator.implementation = null;

  assert.equal(registry.get('codex').get('sessionLocator').source, 'core');
  assert.equal(registry.report()[0].capabilities.sessionLocator.source, 'core');
});
