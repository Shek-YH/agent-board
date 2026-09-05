'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildHeadlessInvocation,
  HeadlessTransport,
  resolveWorkBuddyCliPath,
  createHeadlessCapabilityBinding,
} = require('./transport');

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

test('transport refuses real execution unless the explicit headless flag is enabled', async () => {
  const transport = new HeadlessTransport({
    enabled: true, env: { AGENT_BOARD_HEADLESS_EXECUTION: '0' },
    spawnImpl: () => { throw new Error('must not spawn'); },
  });
  const result = await transport.run({ agent: 'codex', projectPath: '.', prompt: 'x' });
  assert.equal(result.status, 'waiting_user');
});

test('Claude headless invocation resumes the explicitly bound CLI session', () => {
  const invocation = buildHeadlessInvocation({
    agent: 'claude', projectPath: 'C:\\Projects\\demo',
    sessionRef: 'claude:11111111-1111-4111-8111-111111111111', prompt: '检查测试',
  });
  assert.deepEqual(invocation.args, [
    '-p', '检查测试', '--output-format', 'stream-json', '--resume',
    '11111111-1111-4111-8111-111111111111',
  ]);
  assert.equal(invocation.options.shell, false);
  assert.throws(() => buildHeadlessInvocation({
    agent: 'claude', projectPath: 'C:\\Projects\\demo',
    sessionRef: 'workbuddy:11111111-1111-4111-8111-111111111111', prompt: '检查测试',
  }), /session reference/);
});

test('headless invocation rejects an untrusted WorkBuddy executable path', () => {
  assert.throws(() => buildHeadlessInvocation({
    agent: 'workbuddy', projectPath: 'C:\\Projects\\demo', prompt: 'x',
    workbuddyCliPath: 'C:\\Temp\\evil.exe',
  }), /WorkBuddy CLI/);
  assert.throws(() => buildHeadlessInvocation({
    agent: 'workbuddy', projectPath: 'C:\\Projects\\demo', prompt: 'x',
    workbuddyCliPath: 'C:\\Program Files\\WorkBuddy\\cli\\bin\\codebuddy', nodeExecutable: 'C:\\Temp\\evil.exe',
  }), /Node/);
});

test('headless capability is unsupported while execution is disabled', () => {
  assert.equal(typeof createHeadlessCapabilityBinding, 'function');
  if (typeof createHeadlessCapabilityBinding !== 'function') return;
  const binding = createHeadlessCapabilityBinding({ agent: 'claude', enabled: false });
  assert.equal(binding.supported, false);
  assert.match(binding.reason, /disabled|关闭/);
});

test('headless writer requires real vendor delivery evidence before reporting success', async () => {
  assert.equal(typeof createHeadlessCapabilityBinding, 'function');
  if (typeof createHeadlessCapabilityBinding !== 'function') return;
  const binding = createHeadlessCapabilityBinding({
    agent: 'claude', enabled: true,
    runner: { run: async () => ({ status: 'completed', stdout: JSON.stringify({ type: 'assistant', session_id: 'other' }) }) },
  });
  assert.equal(binding.supported, true);
  const target = {
    sessionRef: 'claude:11111111-1111-4111-8111-111111111111', agent: 'claude', project: 'C:\\Projects\\demo',
    role: 'main', controlEligibility: 'eligible',
  };
  const message = '检查测试';
  const draft = await binding.capabilities.messageWriter.write(target, message);
  assert.equal(draft.ok, true);
  assert.equal((await binding.capabilities.messageWriter.verifyDraft(target, message)).matches, true);
  const sent = await binding.capabilities.messageWriter.send(target, { request: { message } });
  assert.equal(sent.ok, false);
  const delivery = await binding.capabilities.deliveryVerifier.verify(target, message, { sent });
  assert.equal(delivery.ok, false);
  assert.equal(delivery.code, 'DELIVERY_UNVERIFIED');
});

test('headless capability exposes identity, writer, and delivery only as a complete set', async () => {
  assert.equal(typeof createHeadlessCapabilityBinding, 'function');
  if (typeof createHeadlessCapabilityBinding !== 'function') return;
  let invocation;
  const binding = createHeadlessCapabilityBinding({
    agent: 'workbuddy', enabled: true,
    workbuddyCliPath: 'C:\\Program Files\\WorkBuddy\\cli\\codebuddy',
    runner: { run: async (request) => {
      invocation = request.invocation;
      return {
        status: 'completed',
        stdout: JSON.stringify({ status: 'completed', sessionId: '22222222-2222-4222-8222-222222222222', delivered: true }),
      };
    } },
  });
  assert.equal(binding.supported, true);
  assert.equal(typeof binding.capabilities.identityVerifier, 'function');
  assert.equal(typeof binding.capabilities.sessionActivator, 'function');
  assert.equal(typeof binding.capabilities.messageWriter.write, 'function');
  assert.equal(typeof binding.capabilities.messageWriter.send, 'function');
  assert.equal(typeof binding.capabilities.deliveryVerifier.verify, 'function');
  const target = {
    sessionRef: 'workbuddy:22222222-2222-4222-8222-222222222222', agent: 'workbuddy', project: 'C:\\Projects\\demo',
    role: 'main', controlEligibility: 'eligible',
  };
  const identity = await binding.capabilities.identityVerifier(target);
  assert.equal(identity.strongAnchor, true);
  assert.equal((await binding.capabilities.sessionActivator(target)).ok, true);
  const message = '执行审核';
  await binding.capabilities.messageWriter.write(target, message);
  const sent = await binding.capabilities.messageWriter.send(target, { request: { message } });
  assert.equal(sent.ok, true);
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.args.at(-1), message);
  assert.equal((await binding.capabilities.deliveryVerifier.verify(target, '被篡改的消息', { sent })).ok, false);
});

test('headless writer fails closed when the target identity drifts after draft verification', async () => {
  const binding = createHeadlessCapabilityBinding({
    agent: 'claude', enabled: true,
    runner: { run: async () => ({
      status: 'completed',
      stdout: JSON.stringify({ type: 'result', session_id: '11111111-1111-4111-8111-111111111111' }),
    }) },
  });
  const target = {
    sessionRef: 'claude:11111111-1111-4111-8111-111111111111', agent: 'claude', project: 'C:\\Projects\\demo',
    role: 'main', controlEligibility: 'eligible',
  };
  const drifted = { ...target, project: 'C:\\Projects\\other' };
  await binding.capabilities.messageWriter.write(target, '检查测试');
  assert.equal((await binding.capabilities.messageWriter.verifyDraft(drifted, '检查测试')).ok, false);
  const sent = await binding.capabilities.messageWriter.send(drifted, { request: { message: '检查测试' } });
  assert.equal(sent.ok, false);
  assert.match(sent.code, /IDENTITY|DRAFT/);
});
