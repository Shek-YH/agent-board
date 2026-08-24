'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const helperPath = path.join(__dirname, 'deepseek-desktop-deep-link.js');

test('为合法 DeepSeek Harness sessionId 构造桌面端深链', () => {
  assert.equal(fs.existsSync(helperPath), true, 'DeepSeek Desktop 深链模块尚未实现');
  const { buildDeepSeekDesktopDeepLink } = require('./deepseek-desktop-deep-link');
  assert.equal(
    buildDeepSeekDesktopDeepLink('session-01HXYZ123'),
    'dshdesktop://open/session/session-01HXYZ123?source=agent-board',
  );
});

test('DeepSeek sessionId 必须被 URL 编码且拒绝任意协议内容', () => {
  assert.equal(fs.existsSync(helperPath), true, 'DeepSeek Desktop 深链模块尚未实现');
  const { buildDeepSeekDesktopDeepLink } = require('./deepseek-desktop-deep-link');
  assert.equal(
    buildDeepSeekDesktopDeepLink('session-中文'),
    'dshdesktop://open/session/session-%E4%B8%AD%E6%96%87?source=agent-board',
  );
  assert.throws(() => buildDeepSeekDesktopDeepLink('javascript:alert(1)'), /无效的 DeepSeek sessionId/);
  assert.throws(() => buildDeepSeekDesktopDeepLink('session/other'), /无效的 DeepSeek sessionId/);
});
