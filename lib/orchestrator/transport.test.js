'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { buildHeadlessInvocation, HeadlessTransport, resolveWorkBuddyCliPath } = require('./transport');

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

test('WorkBuddy headless invocation uses its bundled CLI with fixed non-interactive flags', () => {
  const invocation = buildHeadlessInvocation({
    agent: 'workbuddy', projectPath: 'C:\\Projects\\demo', prompt: '查询天气',
    workbuddyCliPath: 'F:\\Program Files (x86)\\WorkBuddy\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy',
    nodeExecutable: 'C:\\Program Files\\nodejs\\node.exe',
  });
  assert.equal(invocation.command, 'C:\\Program Files\\nodejs\\node.exe');
  assert.deepEqual(invocation.args, [
    'F:\\Program Files (x86)\\WorkBuddy\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy',
    '--print', '--output-format', 'json', '--max-turns', '3', '查询天气',
  ]);
  assert.equal(invocation.cwd, 'C:\\Projects\\demo');
  assert.equal(invocation.options.shell, false);
});

test('WorkBuddy headless invocation never requests automatic permission approval', () => {
  const invocation = buildHeadlessInvocation({
    agent: 'workbuddy', projectPath: 'C:\\Projects\\demo', prompt: '查询天气',
    workbuddyCliPath: 'F:\\Program Files (x86)\\WorkBuddy\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy',
  });
  assert.equal(invocation.args.includes('--permission-mode'), false);
});

test('WorkBuddy CLI path can be derived from the installed desktop executable', () => {
  assert.equal(
    resolveWorkBuddyCliPath({
      desktopExecutable: 'F:\\Program Files (x86)\\WorkBuddy\\WorkBuddy.exe',
      env: {}, existsSync: (value) => value.endsWith('cli\\bin\\codebuddy'),
    }),
    'F:\\Program Files (x86)\\WorkBuddy\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy',
  );
});

test('transport can be disabled without spawning a process', async () => {
  const transport = new HeadlessTransport({ enabled: false, spawnImpl: () => { throw new Error('must not spawn'); } });
  const result = await transport.run({ agent: 'codex', projectPath: '.', prompt: 'x' });
  assert.equal(result.status, 'waiting_user');
});
