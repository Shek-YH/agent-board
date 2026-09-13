'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createSessionIdentity, runtimeSessionKey, advanceGeneration, sameSessionIdentity } = require('./identity');

test('Session Identity V2 normalizes strong anchors and creates a generation-scoped key', () => {
  const identity = createSessionIdentity({
    agent: 'codex', hostId: 'host-1', nativeSessionId: 'native-1', generation: 2,
    processId: 42, processStartedAt: 100, terminalInstanceId: 'term-1',
    terminalTTY: 'tty-1', workspaceId: 'workspace-1', cwd: 'C:\\same',
    transcriptPath: 'C:\\sessions\\native-1.jsonl', transcriptFileId: 'file-1',
  });

  assert.equal(identity.agent, 'codex');
  assert.equal(identity.hostId, 'host-1');
  assert.equal(identity.generation, 2);
  assert.equal(runtimeSessionKey(identity), 'codex:native-1:gen:2');
  assert.ok(Object.isFrozen(identity));
});

test('generation advances for resume/fork without mutating the previous identity', () => {
  const initial = createSessionIdentity({ agent: 'codex', hostId: 'host-1', nativeSessionId: 'native-1' });
  const resumed = advanceGeneration(initial, 'resume');
  assert.equal(initial.generation, 0);
  assert.equal(resumed.generation, 1);
  assert.equal(resumed.generationReason, 'resume');
  assert.equal(runtimeSessionKey(resumed), 'codex:native-1:gen:1');
});

test('same CWD is not enough to match identities', () => {
  const base = { agent: 'codex', hostId: 'host-1', cwd: 'C:\\same' };
  const first = createSessionIdentity({ ...base, nativeSessionId: 'one' });
  const second = createSessionIdentity({ ...base, nativeSessionId: 'two' });
  const sameProcess = createSessionIdentity({ ...base, processId: 8, processStartedAt: 900 });
  const sameProcessAgain = createSessionIdentity({ ...base, processId: 8, processStartedAt: 900 });

  assert.equal(sameSessionIdentity(first, second), false);
  assert.equal(sameSessionIdentity(sameProcess, sameProcessAgain), true);
  assert.throws(() => createSessionIdentity({ agent: '', hostId: 'host' }), /agent/);
  assert.throws(() => createSessionIdentity({ agent: 'codex', hostId: 'host', generation: -1 }), /generation/);
});
