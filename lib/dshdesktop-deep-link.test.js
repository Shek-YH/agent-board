'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

const installedModule = path.join(
  process.env.LOCALAPPDATA || path.join(require('node:os').homedir(), 'AppData', 'Local'),
  'Programs', 'DSH Desktop', 'resources', 'app.asar.unpacked', 'lib', 'session-deep-link.js',
);
const skipReason = fs.existsSync(installedModule) ? false : 'DSH Desktop 内部模块未安装，跳过版本耦合测试';

async function loadParser() {
  return import(pathToFileURL(installedModule).href + `?test=${Date.now()}`);
}

test('DSH Desktop 解析指定 session 深链并提取 Windows 参数', { skip: skipReason }, async () => {
  const { parseDeepLink, extractDeepLinks } = await loadParser();
  assert.deepEqual(parseDeepLink('dshdesktop://open/session/session-01HXYZ123?source=agent-board'), {
    kind: 'session-id',
    sessionId: 'session-01HXYZ123',
    source: 'agent-board',
  });
  assert.deepEqual(extractDeepLinks([
    'C:\\Program Files\\DSH Desktop\\DSH Desktop.exe',
    'dshdesktop://open/session/session-01HXYZ123?source=agent-board',
  ]), ['dshdesktop://open/session/session-01HXYZ123?source=agent-board']);
});

test('DSH Desktop 拒绝非法协议、路径和控制字符', { skip: skipReason }, async () => {
  const { parseDeepLink } = await loadParser();
  assert.equal(parseDeepLink('https://example.com/open/session/foo'), undefined);
  assert.equal(parseDeepLink('dshdesktop://open/other/foo'), undefined);
  assert.equal(parseDeepLink('dshdesktop://open/session/%00bad'), undefined);
});
