'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

test('为合法 Pi Agent sessionId 构造桌面端深链', () => {
  const { buildPiAgentDesktopDeepLink } = require('./pi-agent-deep-link');
  assert.equal(
    buildPiAgentDesktopDeepLink('019f96fe-643b-76de-a797-24a9771496b2'),
    'piagent://open/session/019f96fe-643b-76de-a797-24a9771496b2?source=agent-board',
  );
});

test('Pi sessionId 必须被 URL 编码且拒绝任意协议内容', () => {
  const { buildPiAgentDesktopDeepLink } = require('./pi-agent-deep-link');
  assert.equal(
    buildPiAgentDesktopDeepLink('session-中文'),
    'piagent://open/session/session-%E4%B8%AD%E6%96%87?source=agent-board',
  );
  assert.throws(() => buildPiAgentDesktopDeepLink('javascript:alert(1)'), /无效的 Pi Agent sessionId/);
  assert.throws(() => buildPiAgentDesktopDeepLink('session/other'), /无效的 Pi Agent sessionId/);
});
