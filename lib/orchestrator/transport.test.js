'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { buildHeadlessInvocation, HeadlessTransport } = require('./transport');

test('headless invocation uses a fixed agent profile and never invokes a shell', () => {
  const invocation = buildHeadlessInvocation({
    agent: 'codex', projectPath: 'C:\\Projects\\demo', prompt: '修复测试失败',
  });
  assert.equal(invocation.command, 'codex');
  assert.deepEqual(invocation.args, ['exec', '--json', '修复测试失败']);
  assert.equal(invocation.cwd, 'C:\\Projects\\demo');
  assert.equal(invocation.options.shell, false);
});

test('unsupported or unconfigured agents cannot become arbitrary commands', () => {
  assert.throws(() => buildHeadlessInvocation({ agent: 'other', projectPath: '.', prompt: 'x' }), /unsupported agent/);
  assert.throws(() => buildHeadlessInvocation({ agent: 'workbuddy', projectPath: '.', prompt: 'x' }), /headless profile/);
});

test('transport can be disabled without spawning a process', async () => {
  const transport = new HeadlessTransport({ enabled: false, spawnImpl: () => { throw new Error('must not spawn'); } });
  const result = await transport.run({ agent: 'codex', projectPath: '.', prompt: 'x' });
  assert.equal(result.status, 'waiting_user');
});
