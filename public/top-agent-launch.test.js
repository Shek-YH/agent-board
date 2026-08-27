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

test('启动结果必须经过真实窗口验证，失败时给出恢复路径', () => {
  assert.match(server, /function verifyAgentWindow\(agent, cb/);
  assert.match(server, /code: 'launch-not-verified'/);
  assert.match(server, /buildLaunchRecovery\(agent, requestedTarget\)/);
  assert.match(app, /recovery\?\.autoConfigureAvailable/);
  assert.match(app, /discover-path/);
  assert.match(app, /正在重试/);
});

test('Pi 顶部快捷入口启动桌面端，不进入 3210 Web UI 分支', () => {
  assert.match(
    server,
    /if \(agent === 'pi'\)[\s\S]*?resolvePiAgentDesktopExe\(\)[\s\S]*?launchGuiViaShell\(desktopExe\)/,
  );
  assert.doesNotMatch(
    server,
    /if \(agent === 'pi'\)[\s\S]*?if \(def\.webUi\)/,
  );
});

test('Hermes 顶部快捷入口仍启动桌面端', () => {
  assert.match(
    server,
    /if \(agent === 'hermes'\)[\s\S]*?resolveHermesDesktopExe\(\)[\s\S]*?launchGuiViaShell\(desktopExe\)/,
  );
});

test('Claude 顶部快捷入口通过 Deep Link 启动，避免直接打开受保护的 WindowsApps exe', () => {
  assert.match(server, /resolveClaudeDesktopExe\(\)/);
  assert.match(server, /claude:\s*file\(resolveClaudeDesktopExe\(\), 'Claude Desktop'\)/);
  assert.match(server, /function launchClaudeDesktop\(cb\)[\s\S]*?launchClaudeDeepLink\('claude:\/\/'\)/);
  assert.doesNotMatch(server, /if \(agent === 'claude'\) launchGuiViaShell\(configuredExecutable\)/);
});

test('ZCode 顶部快捷入口优先启动已探测到的 Desktop exe，不再优先执行旧 bat', () => {
  assert.match(server, /function launchZCodeDesktop\(cb\)[\s\S]*?resolveAgentGuiExecutable\('zcode'\)[\s\S]*?launchDetachedTarget/);
  assert.match(server, /if \(agent === 'zcode'\) \{[\s\S]*?launchZCodeDesktop\(cb\)/);
});
