'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const CLI_ID = '58f71b61-20f3-454e-bc48-fe3d665b9e37';
const NATIVE_CLI_ID = '11111111-2222-4333-8444-555555555555';
const NATIVE_DESKTOP_ID = 'local_d51e78e9-4eac-4fc1-94c4-c7ea88059317';

function fixtureRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-board-claude-'));
}

function writeDescriptor(root, relativePath, descriptor) {
  const file = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(descriptor));
  return file;
}

test('递归读取 Claude Desktop descriptor 并保留定位所需字段', () => {
  const root = fixtureRoot();
  try {
    writeDescriptor(root, 'account/org/local_abc.json', {
      sessionId: 'local_abc',
      cliSessionId: CLI_ID,
      cwd: 'D:\\项目 A',
      title: '修复登录流程',
      lastActivityAt: 1234,
      archived: false,
      ignored: 'not exposed',
    });
    fs.writeFileSync(path.join(root, 'account/org/not-a-session.json'), '{}');

    const { listClaudeDesktopSessions } = require('./claude-desktop-session');
    assert.deepEqual(listClaudeDesktopSessions(root), [{
      sessionId: 'local_abc',
      cliSessionId: CLI_ID,
      cwd: 'D:\\项目 A',
      title: '修复登录流程',
      lastActivityAt: 1234,
      archived: false,
    }]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Windows MSIX Claude Desktop 从 LocalCache/Packages 路径发现 session registry', () => {
  const root = fixtureRoot();
  try {
    const appData = path.join(root, 'roaming');
    const localAppData = path.join(root, 'local');
    const packageRoot = path.join(localAppData, 'Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache', 'Roaming', 'Claude', 'claude-code-sessions');
    writeDescriptor(packageRoot, 'account/org/local_msix.json', {
      sessionId: 'local_msix', cliSessionId: CLI_ID, cwd: 'D:\\msix', title: 'MSIX',
    });
    const { defaultClaudeDesktopSessionsRoots, listClaudeDesktopSessions } = require('./claude-desktop-session');
    const roots = defaultClaudeDesktopSessionsRoots({ APPDATA: appData, LOCALAPPDATA: localAppData }, root);
    assert.ok(roots.includes(packageRoot));
    assert.deepEqual(listClaudeDesktopSessions(roots).map((item) => item.sessionId), ['local_msix']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CLI-only 会话使用 resume 深链并正确编码 cwd', () => {
  const root = fixtureRoot();
  try {
    const { resolveClaudeSessionTarget } = require('./claude-desktop-session');
    const target = resolveClaudeSessionTarget({
      cliSessionId: CLI_ID,
      cwd: 'D:\\中文项目\\Task Hub',
      root,
    });
    assert.equal(target.origin, 'cli');
    assert.equal(target.action, 'resume');
    assert.equal(target.desktopSessionId, undefined);
    assert.equal(
      target.deepLink,
      'claude://resume?session=58f71b61-20f3-454e-bc48-fe3d665b9e37&cwd=D%3A%5C%E4%B8%AD%E6%96%87%E9%A1%B9%E7%9B%AE%5CTask%20Hub',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('已经导入的 CLI 会话继续使用 resume 并按 local_<cliSessionId> 去重', () => {
  const root = fixtureRoot();
  try {
    writeDescriptor(root, 'account/local_ignored.json', {
      sessionId: `local_${CLI_ID}`,
      cliSessionId: CLI_ID,
      cwd: 'D:\\project',
      title: '已导入',
    });
    const { resolveClaudeSessionTarget } = require('./claude-desktop-session');
    const target = resolveClaudeSessionTarget({ cliSessionId: CLI_ID, cwd: 'D:\\project', root });
    assert.equal(target.origin, 'imported-cli');
    assert.equal(target.action, 'resume');
    assert.equal(target.desktopSessionId, `local_${CLI_ID}`);
    assert.equal(target.deepLink, `claude://resume?session=${CLI_ID}&cwd=D%3A%5Cproject`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Desktop-native 会话使用 desktopSessionId 的 focus 深链，禁止退回 resume', () => {
  const root = fixtureRoot();
  try {
    writeDescriptor(root, 'account/org/local_native.json', {
      sessionId: NATIVE_DESKTOP_ID,
      cliSessionId: NATIVE_CLI_ID,
      cwd: 'D:\\native-project',
      title: '原生桌面会话',
    });
    const { resolveClaudeSessionTarget } = require('./claude-desktop-session');
    const target = resolveClaudeSessionTarget({ cliSessionId: NATIVE_CLI_ID, cwd: 'D:\\native-project', root });
    assert.equal(target.origin, 'desktop');
    assert.equal(target.action, 'focus');
    assert.equal(target.desktopSessionId, NATIVE_DESKTOP_ID);
    assert.equal(target.deepLink, `claude://claude.ai/code/${NATIVE_DESKTOP_ID}`);
    assert.doesNotMatch(target.deepLink, /resume/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('同一 cliSessionId 存在多个 descriptor 时返回 ambiguous，不能静默打开第一个', () => {
  const root = fixtureRoot();
  try {
    const base = { cliSessionId: NATIVE_CLI_ID, title: '重复', cwd: 'D:\\project' };
    writeDescriptor(root, 'account-a/local_a.json', { ...base, sessionId: 'local_a' });
    writeDescriptor(root, 'account-b/local_b.json', { ...base, sessionId: 'local_b' });
    const { resolveClaudeSessionTarget } = require('./claude-desktop-session');
    const target = resolveClaudeSessionTarget({ cliSessionId: NATIVE_CLI_ID, cwd: 'D:\\project', root });
    assert.equal(target.status, 'ambiguous');
    assert.equal(target.candidates.length, 2);
    assert.equal(target.deepLink, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
