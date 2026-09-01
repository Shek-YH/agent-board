'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { collectProjectEvidence, parseCommand } = require('./evidence-collector');

function workflow(permission = {}) {
  return {
    projectPath: 'C:\\Projects\\demo',
    permissionSnapshot: {
      allowGit: true, allowedGitOperations: ['status', 'diff'], allowTests: true,
      allowedCommands: ['node --test', 'npm test'], ...permission,
    },
    runContract: { verify: { evidence: ['node --test', 'npm test', 'npm run lint', 'echo should-not-run'] } },
  };
}

test('evidence collector runs only bounded Git checks and whitelisted test commands', async () => {
  const calls = [];
  const snapshot = await collectProjectEvidence({
    workflow: workflow(), now: () => 123,
    runCommand: async (command, args, options) => {
      calls.push({ command, args, options });
      return { code: 0, stdout: command === 'git' ? ' M src/app.js' : 'tests passed', stderr: '' };
    },
  });
  assert.deepEqual(calls.map((call) => [call.command, ...call.args]), [
    ['git', 'status', '--short'], ['git', 'diff', '--stat'], ['git', 'diff', '--name-only'],
    ['node', '--test'], ['npm', 'test'],
  ]);
  assert.equal(snapshot.collectedAt, 123);
  assert.equal(snapshot.checks.length, 5);
  assert.equal(snapshot.checks.every((item) => item.status === 'pass'), true);
  assert.equal(snapshot.skipped.length, 1);
  assert.match(snapshot.skipped[0].reason, /白名单/);
  assert.equal(calls[0].options.cwd, 'C:\\Projects\\demo');
});

test('evidence collector fails closed for disabled permissions and sanitizes outputs', async () => {
  const calls = [];
  const snapshot = await collectProjectEvidence({
    workflow: workflow({ allowGit: false, allowTests: false }),
    runCommand: async (...args) => { calls.push(args); return { code: 0, stdout: 'should not run' }; },
  });
  assert.equal(calls.length, 0);
  assert.equal(snapshot.checks.length, 0);
  assert.equal(snapshot.skipped.length, 6);

  const safe = await collectProjectEvidence({
    workflow: workflow({ allowedCommands: ['npm test'] }),
    runCommand: async (command) => command === 'git'
      ? { code: 0, stdout: 'token=secret-value\nC:\\Projects\\demo\\.env', stderr: '' }
      : { code: 1, stdout: '', stderr: 'password=secret-password' },
  });
  const serialized = JSON.stringify(safe);
  assert.doesNotMatch(serialized, /secret-value|secret-password|C:\\Projects\\demo/);
  assert.match(serialized, /REDACTED|BLOCKED_PATH/);
});

test('evidence command parser rejects shell composition', () => {
  assert.deepEqual(parseCommand('npm test tests/auth.test.js').args, ['test', 'tests/auth.test.js']);
  assert.equal(parseCommand('npm test && whoami'), null);
  assert.equal(parseCommand(''), null);
});
