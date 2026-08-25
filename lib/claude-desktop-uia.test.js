'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

test('Claude UIA fallback 使用 Accessibility Tree、session 标识和标题匹配', () => {
  const { buildClaudeUiAutomationScript } = require('./claude-desktop-uia');
  const script = buildClaudeUiAutomationScript();
  assert.match(script, /UIAutomationClient/);
  assert.match(script, /AGENT_BOARD_CLAUDE_DESKTOP_SESSION_ID/);
  assert.match(script, /AGENT_BOARD_CLAUDE_TITLE/);
  assert.match(script, /SelectionItemPattern/);
  assert.match(script, /AMBIGUOUS/);
  assert.match(script, /NameProperty/);
  assert.match(script, /normalizedName/);
  assert.match(script, /titlePrefix/);
  assert.match(script, /RootElement/);
  assert.match(script, /SetForegroundWindow/);
  assert.match(script, /IsZoomed/);
  assert.match(script, /ShowWindow\(h, 3\)/);
  assert.match(script, /Current\.Name -eq 'Code'/);
  assert.match(script, /if \(-not \$codeWindow\)/);
  assert.doesNotMatch(script, /ActivateWindow\(\$codeHandle\)/, 'UIA 不能先抢占 Code 窗口前台');
});

test('非 Windows 不执行 Claude UIA fallback', async () => {
  const { focusClaudeSessionWithUiAutomation } = require('./claude-desktop-uia');
  const result = await focusClaudeSessionWithUiAutomation({
    action: 'focus', desktopSessionId: 'local_abc', title: 'test', cwd: 'D:\\test',
  }, { platform: 'darwin' });
  assert.deepEqual(result, { status: 'unsupported' });
});

test('已导入 CLI session 也允许 UIA 按 desktopSessionId 聚焦', async () => {
  const { focusClaudeSessionWithUiAutomation } = require('./claude-desktop-uia');
  const result = await focusClaudeSessionWithUiAutomation({
    action: 'resume', desktopSessionId: 'local_abc', title: 'test', cwd: 'D:\\test',
  }, { platform: 'darwin' });
  assert.deepEqual(result, { status: 'unsupported' });
});

test('UIA helper 超时会终止失控的 PowerShell 子进程', async () => {
  const { focusClaudeSessionWithUiAutomation } = require('./claude-desktop-uia');
  let killed = false;
  const child = {
    stdout: { on() {} },
    stderr: { on() {} },
    once() {},
    kill() { killed = true; },
  };
  const result = await focusClaudeSessionWithUiAutomation({
    action: 'focus', desktopSessionId: 'local_abc', title: 'test', cwd: 'D:\\test',
  }, {
    platform: 'win32', executable: 'powershell.exe', spawn: () => child, timeoutMs: 10,
  });
  assert.equal(result.status, 'timeout');
  assert.equal(killed, true);
});
