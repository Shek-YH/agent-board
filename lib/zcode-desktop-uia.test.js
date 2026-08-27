'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

test('ZCode UIA 按 session ID/任务标题定位并点击任务项', () => {
  const { buildZCodeUiAutomationScript } = require('./zcode-desktop-uia');
  const script = buildZCodeUiAutomationScript();
  assert.match(script, /UIAutomationClient/);
  assert.match(script, /AGENT_BOARD_ZCODE_TITLE/);
  assert.match(script, /AGENT_BOARD_ZCODE_SESSION_ID/);
  assert.match(script, /AGENT_BOARD_ZCODE_CWD/);
  assert.match(script, /group\/task-item/);
  assert.match(script, /AutomationId/);
  assert.match(script, /ControlType\.Button/);
  assert.match(script, /ControlType\.Group/);
  assert.match(script, /AMBIGUOUS/);
  assert.match(script, /mouse_event/);
  assert.match(script, /SetForegroundWindow/);
  assert.match(script, /DONE:OK/);
});

test('ZCode 找不到唯一任务时立即结束脚本，不启动、滚动或重试', () => {
  const { buildZCodeUiAutomationScript } = require('./zcode-desktop-uia');
  const script = buildZCodeUiAutomationScript();
  assert.doesNotMatch(script, /for \(\$attempt = 0;/);
  assert.doesNotMatch(script, /Scroll-ZCodeSidebar/);
  assert.doesNotMatch(script, /Start-Sleep/);
  assert.match(script, /Write-Output 'DONE:NOT_FOUND'/);
  assert.doesNotMatch(script, /MainWindowHandle -ne 0/);
});

test('非 Windows 不执行 ZCode UIA 跳转', async () => {
  const { focusZCodeSessionWithUiAutomation } = require('./zcode-desktop-uia');
  const result = await focusZCodeSessionWithUiAutomation({ title: 'test', cwd: 'D:\\test' }, { platform: 'darwin' });
  assert.deepEqual(result, { status: 'unsupported' });
});

test('ZCode UIA helper 超时会终止 PowerShell 子进程', async () => {
  const { focusZCodeSessionWithUiAutomation } = require('./zcode-desktop-uia');
  let killed = false;
  const child = {
    stdout: { on() {} },
    stderr: { on() {} },
    once() {},
    kill() { killed = true; },
  };
  const result = await focusZCodeSessionWithUiAutomation({ sessionId: 'sess_test', title: 'test', cwd: 'D:\\test' }, {
    platform: 'win32', executable: 'powershell.exe', spawn: () => child, timeoutMs: 10,
  });
  assert.equal(result.status, 'timeout');
  assert.equal(killed, true);
});
