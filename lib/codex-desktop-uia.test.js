'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const TARGET = {
  agent: 'codex',
  sessionRef: 'codex:2026-08-30T00-00-00-019e4751-d521-7290-9627-e501f3d7d2d3',
  project: 'C:/repo',
  title: 'POC',
};

function fakeChild(payload) {
  const stdout = {
    on(event, handler) {
      if (event === 'data') process.nextTick(() => handler(Buffer.from(JSON.stringify(payload))));
    },
  };
  const stderr = { on() {} };
  return {
    stdout,
    stderr,
    once(event, handler) {
      if (event === 'close') process.nextTick(() => handler(0));
    },
    kill() {},
  };
}

test('Codex UIA script requires the strong session anchor and the unique ProseMirror edit control', () => {
  const { buildCodexUiAutomationScript } = require('./codex-desktop-uia');
  const script = buildCodexUiAutomationScript();
  assert.match(script, /UIAutomationClient/);
  assert.match(script, /AGENT_BOARD_CODEX_THREAD_ID/);
  assert.match(script, /AGENT_BOARD_CODEX_TITLE/);
  assert.match(script, /SESSION_TITLE_NOT_FOUND/);
  assert.match(script, /\$candidate -ceq \$stored/);
  assert.match(script, /ControlType\.ListItem/);
  assert.match(script, /ControlType\.Edit/);
  assert.match(script, /随心输入/);
  assert.match(script, /NormalizeDraftValue/);
  assert.match(script, /Start-Sleep -Milliseconds 50/);
  assert.match(script, /try \{\s*\$composer\.SetFocus\(\)/);
  assert.doesNotMatch(script, /if \(-not \$composer\.SetFocus\(\)\)/);
  assert.match(script, /ProseMirror/);
  assert.match(script, /ValuePattern/);
  assert.match(script, /SetValue/);
  assert.match(script, /SetFocus/);
  assert.match(script, /SendEnter/);
  assert.match(script, /Get-Process -Name 'ChatGPT','Codex'/);
  assert.doesNotMatch(script, /Set-Clipboard|SetClipboard|Get-Clipboard/);
  assert.doesNotMatch(script, /\r?\n\s+-and\b/);
  assert.doesNotMatch(script, /\$matches\b/i);
});

test('Codex UIA accepts only a bounded unique suffix after the exact stored title', () => {
  const { sessionTitleMatchKind } = require('./codex-desktop-uia');
  assert.equal(sessionTitleMatchKind('POC', 'POC'), 'exact');
  assert.equal(sessionTitleMatchKind('POC Codex', 'POC'), 'truncated-prefix');
  assert.equal(sessionTitleMatchKind('POC other session', 'POC'), 'truncated-prefix');
  assert.equal(sessionTitleMatchKind('Another session', 'POC'), 'none');
  assert.equal(sessionTitleMatchKind('POC'.padEnd(80, 'x'), 'POC'), 'none');
});

test('Codex writer uses the injected PowerShell bridge and preserves draft readback evidence', async () => {
  const { createCodexWriter, verifyCodexDraft, verifyCodexDesktopSession } = require('./codex-desktop-uia');
  const calls = [];
  const options = {
    platform: 'win32',
    executable: 'powershell.exe',
    spawn: (command, args, spawnOptions) => {
      calls.push({ command, args, spawnOptions });
      return fakeChild({
        ok: true,
        matches: true,
        strongAnchor: true,
        anchor: 'uia:thread-1',
        composerCount: 1,
        readbackLength: 5,
      });
    },
  };
  const writer = createCodexWriter(options);
  const written = await writer.write(TARGET, 'hello');
  const draft = await verifyCodexDraft(TARGET, 'hello', options);
  const session = await verifyCodexDesktopSession(TARGET, options);

  assert.equal(written.ok, true);
  assert.equal(written.matches, true);
  assert.equal(draft.ok, true);
  assert.equal(session.strongAnchor, true);
  assert.deepEqual(calls.map((item) => item.spawnOptions.env.AGENT_BOARD_CODEX_UIA_ACTION), [
    'write', 'verify-draft', 'verify-session',
  ]);
  assert.equal(calls[0].spawnOptions.env.AGENT_BOARD_CODEX_THREAD_ID, '019e4751-d521-7290-9627-e501f3d7d2d3');
});

test('Codex writer returns DRAFT_PRESENT without silently replacing user text', async () => {
  const { createCodexWriter } = require('./codex-desktop-uia');
  let action = '';
  const writer = createCodexWriter({
    platform: 'win32',
    spawn: (command, args, spawnOptions) => {
      action = spawnOptions.env.AGENT_BOARD_CODEX_UIA_ACTION;
      return fakeChild({ ok: false, code: 'DRAFT_PRESENT', reason: 'existing user draft' });
    },
  });

  const result = await writer.write(TARGET, 'hello');
  assert.equal(action, 'write');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'DRAFT_PRESENT');
});

test('Codex UIA writer rejects an unverifiable target before launching PowerShell', async () => {
  const { createCodexWriter } = require('./codex-desktop-uia');
  let spawnCalls = 0;
  const writer = createCodexWriter({ platform: 'win32', spawn: () => { spawnCalls++; return fakeChild({ ok: true }); } });

  const result = await writer.write({ agent: 'codex', sessionRef: 'codex:not-a-thread' }, 'hello');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'TARGET_ANCHOR_MISSING');
  assert.equal(spawnCalls, 0);
});

test('Codex send calls the bridge once and unsupported platforms never touch the desktop', async () => {
  const { createCodexWriter } = require('./codex-desktop-uia');
  let sendCalls = 0;
  const writer = createCodexWriter({
    platform: 'win32',
    spawn: () => { sendCalls++; return fakeChild({ ok: true, sent: true }); },
  });
  const sent = await writer.send(TARGET, { request: { message: 'hello' } });
  assert.equal(sent.ok, true);
  assert.equal(sendCalls, 1);

  const unsupported = createCodexWriter({ platform: 'darwin', spawn: () => { throw new Error('must not spawn'); } });
  assert.deepEqual(
    await unsupported.send(TARGET, { request: { message: 'hello' } }),
    { ok: false, code: 'UIA_UNSUPPORTED', reason: 'Codex UIA 只支持 Windows' },
  );
});
