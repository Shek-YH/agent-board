'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

test('Windows Claude Deep Link 通过 PowerShell 传给 Shell，不经过 cmd.exe', async () => {
  const calls = [];
  const { launchClaudeDeepLink } = require('./claude-desktop-launcher');
  await launchClaudeDeepLink('claude://resume?session=abc&cwd=D%3A%5CProject', {
    platform: 'win32',
    spawn: (...args) => {
      calls.push(args);
      return { unref() {} };
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'powershell.exe');
  assert.deepEqual(calls[0][1], [
    '-NoProfile', '-NonInteractive', '-Command',
    'Start-Process -FilePath $env:AGENT_BOARD_CLAUDE_DEEPLINK',
  ]);
  assert.equal(calls[0][2].env.AGENT_BOARD_CLAUDE_DEEPLINK, 'claude://resume?session=abc&cwd=D%3A%5CProject');
  assert.notEqual(calls[0][2].detached, true);
  assert.doesNotMatch(calls[0][0], /cmd/i);
});
