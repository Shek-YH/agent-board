'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const app = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('顶部快捷入口仍统一调用启动接口', () => {
  assert.match(app, /btn\.onclick = \(\) => launchAgent\(id\)/);
});

test('Pi 顶部快捷入口启动桌面端，不进入 3210 Web UI 分支', () => {
  assert.match(
    server,
    /if \(agent === 'pi'\)[\s\S]*?resolvePiAgentDesktopExe\(\)[\s\S]*?spawn\(desktopExe, \[\],/,
  );
  assert.doesNotMatch(
    server,
    /if \(agent === 'pi'\)[\s\S]*?if \(def\.webUi\)/,
  );
});

test('Hermes 顶部快捷入口仍启动桌面端', () => {
  assert.match(
    server,
    /if \(agent === 'hermes'\)[\s\S]*?resolveHermesDesktopExe\(\)[\s\S]*?spawn\(desktopExe, \[\],/,
  );
});
