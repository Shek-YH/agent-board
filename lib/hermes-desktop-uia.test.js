'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const TARGET = {
  agent: 'hermes',
  sessionRef: 'hermes:session-1',
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

test('Hermes UIA script requires a session anchor, unique Edit control, and no clipboard path', () => {
  const { buildHermesUiAutomationScript } = require('./hermes-desktop-uia');
  const script = buildHermesUiAutomationScript();
  assert.match(script, /UIAutomationClient/);
  assert.match(script, /AGENT_BOARD_HERMES_SESSION_ID/);
  assert.match(script, /AGENT_BOARD_HERMES_TITLE/);
  assert.match(script, /SESSION_TITLE_NOT_FOUND/);
  assert.match(script, /-ceq \$selectionName/);
  assert.match(script, /Reorder/);
  assert.match(script, /ControlType\.Edit/);
  assert.match(script, /\$info\.Name -ceq '消息'/);
  assert.match(script, /我们要构建什么？/);
  assert.match(script, /随便问点什么/);
  assert.match(script, /调整或继续/);
  assert.match(script, /IsEmptyDraft/);
  assert.match(script, /NormalizeDraftValue/);
  assert.match(script, /Start-Sleep -Milliseconds 50/);
  assert.match(script, /ValuePattern/);
  assert.match(script, /SetValue/);
  assert.match(script, /SetFocus/);
  assert.match(script, /try \{\s*\$composer\.SetFocus\(\)/);
  assert.doesNotMatch(script, /if \(-not \$composer\.SetFocus\(\)\)/);
  assert.match(script, /SendEnter/);
  assert.match(script, /Get-Process -Name 'Hermes'/);
  assert.match(script, /composerCount/);
  assert.doesNotMatch(script, /Set-Clipboard|SetClipboard|Get-Clipboard/);
  assert.doesNotMatch(script, /\r?\n\s+-and\b/);
  assert.doesNotMatch(script, /\$matches\b/i);
});

test('Hermes writer uses the injected bridge for write, draft verify, and session verify', async () => {
  const { createHermesWriter, verifyHermesDraft, verifyHermesDesktopSession } = require('./hermes-desktop-uia');
  const calls = [];
  const options = {
    platform: 'win32',
    executable: 'powershell.exe',
    spawn: (command, args, spawnOptions) => {
      calls.push({ command, args, spawnOptions });
      return fakeChild({ ok: true, matches: true, strongAnchor: true, anchor: 'uia:session-1', composerCount: 1 });
    },
  };
  const writer = createHermesWriter(options);
  const written = await writer.write(TARGET, 'hello');
  const draft = await verifyHermesDraft(TARGET, 'hello', options);
  const session = await verifyHermesDesktopSession(TARGET, options);

  assert.equal(written.ok, true);
  assert.equal(draft.matches, true);
  assert.equal(session.strongAnchor, true);
  assert.deepEqual(calls.map((item) => item.spawnOptions.env.AGENT_BOARD_HERMES_UIA_ACTION), [
    'write', 'verify-draft', 'verify-session',
  ]);
  assert.equal(calls[0].spawnOptions.env.AGENT_BOARD_HERMES_SESSION_ID, 'session-1');
});

test('Hermes writer does not overwrite an existing draft', async () => {
  const { createHermesWriter } = require('./hermes-desktop-uia');
  const writer = createHermesWriter({
    platform: 'win32',
    spawn: () => fakeChild({ ok: false, code: 'DRAFT_PRESENT', reason: 'existing user draft' }),
  });
  const result = await writer.write(TARGET, 'hello');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'DRAFT_PRESENT');
});

test('Hermes writer rejects a target without a valid session anchor', async () => {
  const { createHermesWriter } = require('./hermes-desktop-uia');
  let spawnCalls = 0;
  const writer = createHermesWriter({ platform: 'win32', spawn: () => { spawnCalls++; return fakeChild({ ok: true }); } });
  const result = await writer.write({ agent: 'hermes', sessionRef: 'hermes:' }, 'hello');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'TARGET_ANCHOR_MISSING');
  assert.equal(spawnCalls, 0);
});

test('Hermes send is one bridge call and is unsupported outside Windows', async () => {
  const { createHermesWriter } = require('./hermes-desktop-uia');
  let sendCalls = 0;
  const writer = createHermesWriter({
    platform: 'win32',
    spawn: () => { sendCalls++; return fakeChild({ ok: true, sent: true }); },
  });
  const sent = await writer.send(TARGET, { request: { message: 'hello' } });
  assert.equal(sent.ok, true);
  assert.equal(sendCalls, 1);

  const unsupported = createHermesWriter({ platform: 'darwin', spawn: () => { throw new Error('must not spawn'); } });
  assert.deepEqual(
    await unsupported.send(TARGET, { request: { message: 'hello' } }),
    { ok: false, code: 'UIA_UNSUPPORTED', reason: 'Hermes UIA 只支持 Windows' },
  );
});
