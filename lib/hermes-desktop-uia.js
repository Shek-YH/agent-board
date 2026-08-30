'use strict';

const { spawn, spawnSync } = require('child_process');
const { isValidHermesSessionId } = require('./hermes-deep-link');

function resolvePowerShellExecutable() {
  if (process.platform !== 'win32') return 'powershell.exe';
  const result = spawnSync('where.exe', ['pwsh.exe'], {
    windowsHide: true,
    encoding: 'utf8',
  });
  return result.status === 0 && result.stdout && result.stdout.trim()
    ? 'pwsh.exe'
    : 'powershell.exe';
}

const HERMES_UIA_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class AgentBoardHermesInput {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  public static void Activate(IntPtr h) {
    SetForegroundWindow(h);
    BringWindowToTop(h);
  }
  public static void SendEnter() {
    keybd_event(0x0D, 0, 0, UIntPtr.Zero);
    keybd_event(0x0D, 0, 2, UIntPtr.Zero);
  }
}
'@

$action = $env:AGENT_BOARD_HERMES_UIA_ACTION
$sessionId = $env:AGENT_BOARD_HERMES_SESSION_ID
$title = $env:AGENT_BOARD_HERMES_TITLE
$expected = $env:AGENT_BOARD_HERMES_MESSAGE

function Emit($payload) {
  $payload | ConvertTo-Json -Compress -Depth 8
}

function Fail($code, $reason, $extra = @{}) {
  $payload = @{ ok = $false; code = $code; reason = $reason }
  foreach ($key in $extra.Keys) { $payload[$key] = $extra[$key] }
  Emit $payload
  exit
}

function ElementMetadata($element) {
  $info = $element.Current
  return (($info.Name, $info.AutomationId, $info.HelpText, $info.ClassName, $info.FrameworkId) -join ' ')
}

function NormalizeDraftValue($value) {
  $text = [string]$value
  foreach ($placeholder in @(
    '我们要构建什么？', '给 Hermes 一个任务', '你在想什么？', '描述你需要什么',
    '我们该处理什么？', '随便问点什么', '从一个目标开始', '发送后续消息',
    '补充更多上下文', '细化这个请求', '下一步是什么？', '继续推进', '再深入一点',
    '调整或继续', 'What are we building?', 'Give Hermes a task', "What's on your mind?",
    'Describe what you need', 'What should we tackle?', 'Ask anything', 'Start with a goal',
    'Send a follow-up', 'Add more context', 'Refine the request', "What's next?",
    'Keep it going', 'Push it further', 'Adjust or continue'
  )) {
    if ($text -ceq $placeholder) { return '' }
    if ($text.StartsWith($placeholder, [System.StringComparison]::Ordinal)) {
      $suffix = $text.Substring($placeholder.Length)
      if ($suffix -match '^\r?\n') { return $suffix.Substring(1).TrimStart([char]10) }
    }
  }
  return $text
}

function IsEmptyDraft($value) {
  return [string]::IsNullOrEmpty((NormalizeDraftValue $value))
}

function Find-SessionWindow {
  if (-not $sessionId -or -not $title) { Fail 'TARGET_ANCHOR_MISSING' 'Hermes session ID and exact session title are required' }
  $roots = @()
  foreach ($process in @(Get-Process -Name 'Hermes' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 })) {
    try {
      $roots += [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$process.MainWindowHandle)
    } catch { }
  }
  $windowMatches = @()
  foreach ($root in $roots) {
    $all = $root.FindAll(
      [System.Windows.Automation.TreeScope]::Descendants,
      [System.Windows.Automation.Condition]::TrueCondition
    )
    $selectionName = 'Reorder ' + $title + ' ' + $title
    $identityMatches = @($all | Where-Object {
      $info = $_.Current
      $info.Name -ceq $selectionName -and $info.ControlType.ProgrammaticName -eq 'ControlType.Button'
    })
    if ($identityMatches.Count -eq 1) { $windowMatches += $root }
    elseif ($identityMatches.Count -gt 1) {
      Fail 'SESSION_TITLE_AMBIGUOUS' 'Multiple exact Hermes session title controls were found' @{ matchCount = $identityMatches.Count }
    }
  }
  $distinct = @($windowMatches | Sort-Object { $_.Current.NativeWindowHandle } -Unique)
  if ($distinct.Count -eq 0) { Fail 'SESSION_TITLE_NOT_FOUND' 'Accessibility tree does not expose the exact target Hermes session title' }
  if ($distinct.Count -ne 1) { Fail 'SESSION_AMBIGUOUS' 'Multiple Hermes windows expose the target session' @{ windowCount = $distinct.Count } }
  return $distinct[0]
}

function Find-Composer($window) {
  $all = $window.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.Condition]::TrueCondition
  )
  $composerMatches = @()
  foreach ($element in $all) {
    $info = $element.Current
    $metadata = ElementMetadata $element
    if ($info.ControlType.ProgrammaticName -eq 'ControlType.Edit' -and $info.Name -ceq '消息' -and $metadata -match '(?i)Chromium|Chrome|Hermes') {
      $composerMatches += $element
    }
  }
  if ($composerMatches.Count -eq 0) { Fail 'COMPOSER_NOT_FOUND' 'Unique Hermes message editor was not found' }
  if ($composerMatches.Count -ne 1) { Fail 'COMPOSER_AMBIGUOUS' 'Multiple Hermes message editors were found' @{ composerCount = $composerMatches.Count } }
  return $composerMatches[0]
}

function Get-ValuePattern($composer) {
  $pattern = $null
  if (-not $composer.TryGetCurrentPattern(
    [System.Windows.Automation.ValuePattern]::Pattern,
    [ref]$pattern
  )) {
    Fail 'COMPOSER_NOT_WRITABLE' 'Hermes editor does not expose UIA ValuePattern'
  }
  return $pattern
}

$window = Find-SessionWindow
$handle = [IntPtr]$window.Current.NativeWindowHandle
$anchor = 'uia-session:' + $sessionId + ';window:' + [string]$window.Current.NativeWindowHandle

if ($action -eq 'verify-session') {
  Emit @{ ok = $true; strongAnchor = $true; anchor = $anchor; sessionId = $sessionId; windowCount = 1 }
  exit
}

$composer = Find-Composer $window
$valuePattern = Get-ValuePattern $composer
$current = [string]$valuePattern.Current.Value

if ($action -eq 'write') {
  if (-not (IsEmptyDraft $current)) {
    Fail 'DRAFT_PRESENT' 'Existing Hermes user draft was not overwritten' @{ currentLength = $current.Length; anchor = $anchor }
  }
  try {
    $valuePattern.SetValue($expected)
  } catch {
    Fail 'WRITE_FAILED' 'Hermes ValuePattern.SetValue failed' @{ anchor = $anchor }
  }
  $readback = [string]$valuePattern.Current.Value
  for ($attempt = 0; $attempt -lt 10 -and ((NormalizeDraftValue $readback) -cne $expected); $attempt++) {
    Start-Sleep -Milliseconds 50
    $readback = [string]$valuePattern.Current.Value
  }
  Emit @{
    ok = $true
    matches = ((NormalizeDraftValue $readback) -ceq $expected)
    anchor = $anchor
    composerCount = 1
    readbackLength = $readback.Length
  }
  exit
}

if ($action -eq 'verify-draft') {
  Emit @{
    ok = $true
    matches = ((NormalizeDraftValue $current) -ceq $expected)
    anchor = $anchor
    readbackLength = $current.Length
  }
  exit
}

if ($action -eq 'send') {
  if ((NormalizeDraftValue $current) -cne $expected) {
    Fail 'DRAFT_CHANGED' 'Hermes draft changed before send' @{ anchor = $anchor; currentLength = $current.Length }
  }
  if ($handle -eq [IntPtr]::Zero) { Fail 'WINDOW_HANDLE_MISSING' 'Hermes target window has no native handle' }
  [AgentBoardHermesInput]::Activate($handle)
  try {
    $composer.SetFocus()
  } catch {
    Fail 'COMPOSER_FOCUS_FAILED' 'Hermes editor could not receive focus' @{ anchor = $anchor }
  }
  Start-Sleep -Milliseconds 40
  [AgentBoardHermesInput]::SendEnter()
  Emit @{ ok = $true; sent = $true; anchor = $anchor; method = 'uia-value-pattern+keyboard-enter' }
  exit
}

Fail 'UIA_ACTION_INVALID' 'Unsupported Hermes UIA action'
`;

function targetSessionId(target) {
  if (!target || typeof target !== 'object') return null;
  const explicit = target.sessionId || target.hermesSessionId;
  if (explicit && isValidHermesSessionId(String(explicit))) return String(explicit);
  const ref = String(target.sessionRef || '');
  const value = ref.startsWith('hermes:') ? ref.slice('hermes:'.length) : ref;
  return isValidHermesSessionId(value) ? value : null;
}

function unsupported(platform) {
  return platform !== 'win32'
    ? { ok: false, code: 'UIA_UNSUPPORTED', reason: 'Hermes UIA 只支持 Windows' }
    : null;
}

function parseBridgeOutput(output, errorOutput) {
  const lines = String(output || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index--) {
    try {
      const parsed = JSON.parse(lines[index]);
      if (parsed && typeof parsed === 'object') {
        if (parsed.ok === undefined && parsed.status === 'OK') parsed.ok = true;
        if (errorOutput && !parsed.error) parsed.error = errorOutput;
        return parsed;
      }
    } catch { /* PowerShell may print a non-JSON diagnostic before the result. */ }
  }
  return {
    ok: false,
    code: 'UIA_BRIDGE_INVALID',
    reason: errorOutput || 'Hermes UIA bridge returned no JSON evidence',
  };
}

function runHermesUiAutomation(action, target, message = '', options = {}) {
  const platform = options.platform || process.platform;
  const unsupportedResult = unsupported(platform);
  if (unsupportedResult) return Promise.resolve(unsupportedResult);
  const sessionId = targetSessionId(target);
  if (!sessionId) return Promise.resolve({
    ok: false,
    code: 'TARGET_ANCHOR_MISSING',
    reason: 'Hermes target does not contain a valid session ID',
  });
  const spawnImpl = options.spawn || spawn;
  const executable = options.executable || resolvePowerShellExecutable();
  let child;
  try {
    child = spawnImpl(executable, [
      '-NoProfile', '-NonInteractive', '-Command', options.script || HERMES_UIA_SCRIPT,
    ], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        AGENT_BOARD_HERMES_UIA_ACTION: action,
        AGENT_BOARD_HERMES_SESSION_ID: sessionId,
        AGENT_BOARD_HERMES_SESSION_REF: String(target.sessionRef || ''),
        AGENT_BOARD_HERMES_TITLE: String(target.title || ''),
        AGENT_BOARD_HERMES_MESSAGE: String(message == null ? '' : message),
      },
    });
  } catch (error) {
    return Promise.resolve({ ok: false, code: 'UIA_BRIDGE_START_FAILED', reason: error.message });
  }

  return new Promise((resolve) => {
    let output = '';
    let errorOutput = '';
    let settled = false;
    let timeout = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve(result);
    };
    if (child.stdout && typeof child.stdout.on === 'function') {
      child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    }
    if (child.stderr && typeof child.stderr.on === 'function') {
      child.stderr.on('data', (chunk) => { errorOutput += chunk.toString(); });
    }
    if (typeof child.once === 'function') {
      child.once('error', (error) => finish({ ok: false, code: 'UIA_BRIDGE_FAILED', reason: error.message }));
      child.once('close', () => finish(parseBridgeOutput(output, errorOutput.trim())));
      const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 5000;
      timeout = setTimeout(() => {
        try { child.kill?.(); } catch { /* ignore */ }
        finish({ ok: false, code: 'UIA_TIMEOUT', reason: 'Hermes UIA bridge timed out' });
      }, timeoutMs);
    } else {
      finish(parseBridgeOutput(output, errorOutput.trim()));
    }
  });
}

function createHermesWriter(options = {}) {
  return {
    write(target, message) {
      if (!String(message || '').trim()) {
        return Promise.resolve({ ok: false, code: 'EMPTY_MESSAGE', reason: '消息不能为空' });
      }
      return runHermesUiAutomation('write', target, message, options);
    },
    send(target, context = {}) {
      const message = context && context.request && context.request.message;
      if (!String(message || '').trim()) {
        return Promise.resolve({ ok: false, code: 'SEND_CONTEXT_MISSING', reason: '发送前缺少已验证草稿文本' });
      }
      return runHermesUiAutomation('send', target, message, options);
    },
  };
}

function writeHermesDraft(target, message, options = {}) {
  return createHermesWriter(options).write(target, message);
}

function verifyHermesDraft(target, message, options = {}) {
  if (!String(message || '').trim()) {
    return Promise.resolve({ ok: false, code: 'EMPTY_MESSAGE', reason: '消息不能为空' });
  }
  return runHermesUiAutomation('verify-draft', target, message, options);
}

function verifyHermesDesktopSession(target, options = {}) {
  return runHermesUiAutomation('verify-session', target, '', options);
}

function sendHermesMessage(target, context = {}, options = {}) {
  return createHermesWriter(options).send(target, context);
}

module.exports = {
  buildHermesUiAutomationScript() {
    return HERMES_UIA_SCRIPT;
  },
  createHermesWriter,
  runHermesUiAutomation,
  writeHermesDraft,
  verifyHermesDraft,
  verifyHermesDesktopSession,
  sendHermesMessage,
};
