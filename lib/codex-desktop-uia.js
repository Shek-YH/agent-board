'use strict';

const { spawn, spawnSync } = require('child_process');
const { extractCodexThreadId, isValidCodexThreadId } = require('./codex-deep-link');

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

const CODEX_UIA_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class AgentBoardCodexInput {
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

$action = $env:AGENT_BOARD_CODEX_UIA_ACTION
$threadId = $env:AGENT_BOARD_CODEX_THREAD_ID
$title = $env:AGENT_BOARD_CODEX_TITLE
$expected = $env:AGENT_BOARD_CODEX_MESSAGE

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

function SessionTitleMatchKind($name, $expected) {
  $candidate = [string]$name
  $stored = [string]$expected
  if ([string]::IsNullOrEmpty($candidate) -or [string]::IsNullOrEmpty($stored)) { return 'none' }
  if ($candidate -ceq $stored) { return 'exact' }
  if ($candidate.Length -gt $stored.Length -and $candidate.Length -le ($stored.Length + 32) -and $candidate.StartsWith($stored, [System.StringComparison]::Ordinal)) { return 'truncated-prefix' }
  return 'none'
}

function NormalizeDraftValue($value) {
  $text = [string]$value
  foreach ($placeholder in @('随心输入', 'Type a message', 'Ask anything')) {
    foreach ($prefix in @(
      $placeholder,
      ([string][char]10 + $placeholder),
      ([string][char]13 + [string][char]10 + $placeholder)
    )) {
      if ($text -ceq $prefix) { return '' }
      if ($text.StartsWith($prefix, [System.StringComparison]::Ordinal)) {
        $suffix = $text.Substring($prefix.Length)
        if ($suffix -match '^\r?\n') { return $suffix.Substring(1).TrimStart([char]10) }
      }
    }
  }
  return $text
}

function IsEmptyDraft($value) {
  return [string]::IsNullOrEmpty((NormalizeDraftValue $value))
}

function Find-SessionWindow {
  if (-not $threadId -or -not $title) { Fail 'TARGET_ANCHOR_MISSING' 'Codex thread ID and exact session title are required' }
  $roots = @()
  foreach ($process in @(Get-Process -Name 'ChatGPT','Codex' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 })) {
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
    $identityMatches = @($all | Where-Object {
      $info = $_.Current
      $titleMatch = SessionTitleMatchKind $info.Name $title
      $titleMatch -ne 'none' -and $info.ControlType.ProgrammaticName -eq 'ControlType.ListItem'
    })
    if ($identityMatches.Count -eq 1) { $windowMatches += $root }
    elseif ($identityMatches.Count -gt 1) {
      Fail 'SESSION_TITLE_AMBIGUOUS' 'Multiple exact Codex session title controls were found' @{ matchCount = $identityMatches.Count }
    }
  }
  $distinct = @($windowMatches | Sort-Object { $_.Current.NativeWindowHandle } -Unique)
  if ($distinct.Count -eq 0) { Fail 'SESSION_TITLE_NOT_FOUND' 'Accessibility tree does not expose the exact target Codex session title' }
  if ($distinct.Count -ne 1) { Fail 'SESSION_AMBIGUOUS' 'Multiple Codex windows expose the target thread' @{ windowCount = $distinct.Count } }
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
    if ($info.Name -eq '随心输入' -and $info.ControlType.ProgrammaticName -eq 'ControlType.Edit' -and $metadata -match '(?i)ProseMirror|Chromium|Chrome') {
      $composerMatches += $element
    }
  }
  if ($composerMatches.Count -eq 0) { Fail 'COMPOSER_NOT_FOUND' 'Unique Codex ProseMirror editor was not found' }
  if ($composerMatches.Count -ne 1) { Fail 'COMPOSER_AMBIGUOUS' 'Multiple Codex ProseMirror editors were found' @{ composerCount = $composerMatches.Count } }
  return $composerMatches[0]
}

function Get-ValuePattern($composer) {
  $pattern = $null
  if (-not $composer.TryGetCurrentPattern(
    [System.Windows.Automation.ValuePattern]::Pattern,
    [ref]$pattern
  )) {
    Fail 'COMPOSER_NOT_WRITABLE' 'Codex editor does not expose UIA ValuePattern'
  }
  return $pattern
}

$window = Find-SessionWindow
$handle = [IntPtr]$window.Current.NativeWindowHandle
$anchor = 'uia-thread:' + $threadId + ';window:' + [string]$window.Current.NativeWindowHandle

if ($action -eq 'verify-session') {
  Emit @{ ok = $true; strongAnchor = $true; anchor = $anchor; threadId = $threadId; windowCount = 1 }
  exit
}

$composer = Find-Composer $window
$valuePattern = Get-ValuePattern $composer
$current = [string]$valuePattern.Current.Value

if ($action -eq 'write') {
  if (-not (IsEmptyDraft $current)) {
    Fail 'DRAFT_PRESENT' 'Existing Codex user draft was not overwritten' @{ currentLength = $current.Length; anchor = $anchor }
  }
  try {
    $valuePattern.SetValue($expected)
  } catch {
    Fail 'WRITE_FAILED' 'Codex ValuePattern.SetValue failed' @{ anchor = $anchor }
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
    Fail 'DRAFT_CHANGED' 'Codex draft changed before send' @{ anchor = $anchor; currentLength = $current.Length }
  }
  if ($handle -eq [IntPtr]::Zero) { Fail 'WINDOW_HANDLE_MISSING' 'Codex target window has no native handle' }
  [AgentBoardCodexInput]::Activate($handle)
  try {
    $composer.SetFocus()
  } catch {
    Fail 'COMPOSER_FOCUS_FAILED' 'Codex editor could not receive focus' @{ anchor = $anchor }
  }
  Start-Sleep -Milliseconds 40
  [AgentBoardCodexInput]::SendEnter()
  Emit @{ ok = $true; sent = $true; anchor = $anchor; method = 'uia-value-pattern+keyboard-enter' }
  exit
}

Fail 'UIA_ACTION_INVALID' 'Unsupported Codex UIA action'
`;

function targetThreadId(target) {
  if (!target || typeof target !== 'object') return null;
  const explicit = target.threadId || target.codexThreadId;
  if (explicit && isValidCodexThreadId(String(explicit))) return String(explicit);
  const extracted = extractCodexThreadId(String(target.sessionRef || ''));
  return extracted && isValidCodexThreadId(extracted) ? extracted : null;
}

function sessionTitleMatchKind(name, expected) {
  const candidate = String(name || '');
  const stored = String(expected || '');
  if (!candidate || !stored) return 'none';
  if (candidate === stored) return 'exact';
  if (candidate.length > stored.length
    && candidate.length <= stored.length + 32
    && candidate.startsWith(stored)) return 'truncated-prefix';
  return 'none';
}

function unsupported(platform) {
  return platform !== 'win32'
    ? { ok: false, code: 'UIA_UNSUPPORTED', reason: 'Codex UIA 只支持 Windows' }
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
    reason: errorOutput || 'Codex UIA bridge returned no JSON evidence',
  };
}

function runCodexUiAutomation(action, target, message = '', options = {}) {
  const platform = options.platform || process.platform;
  const unsupportedResult = unsupported(platform);
  if (unsupportedResult) return Promise.resolve(unsupportedResult);
  const threadId = targetThreadId(target);
  if (!threadId) return Promise.resolve({
    ok: false,
    code: 'TARGET_ANCHOR_MISSING',
    reason: 'Codex target does not contain a valid thread ID',
  });
  const spawnImpl = options.spawn || spawn;
  const executable = options.executable || resolvePowerShellExecutable();
  let child;
  try {
    child = spawnImpl(executable, [
      '-NoProfile', '-NonInteractive', '-Command', options.script || CODEX_UIA_SCRIPT,
    ], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        AGENT_BOARD_CODEX_UIA_ACTION: action,
        AGENT_BOARD_CODEX_THREAD_ID: threadId,
        AGENT_BOARD_CODEX_SESSION_REF: String(target.sessionRef || ''),
        AGENT_BOARD_CODEX_TITLE: String(target.title || ''),
        AGENT_BOARD_CODEX_MESSAGE: String(message == null ? '' : message),
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
        finish({ ok: false, code: 'UIA_TIMEOUT', reason: 'Codex UIA bridge timed out' });
      }, timeoutMs);
    } else {
      finish(parseBridgeOutput(output, errorOutput.trim()));
    }
  });
}

function createCodexWriter(options = {}) {
  return {
    write(target, message, context = {}) {
      if (!String(message || '').trim()) {
        return Promise.resolve({ ok: false, code: 'EMPTY_MESSAGE', reason: '消息不能为空' });
      }
      return runCodexUiAutomation('write', target, message, options);
    },
    send(target, context = {}) {
      const message = context && context.request && context.request.message;
      if (!String(message || '').trim()) {
        return Promise.resolve({ ok: false, code: 'SEND_CONTEXT_MISSING', reason: '发送前缺少已验证草稿文本' });
      }
      return runCodexUiAutomation('send', target, message, options);
    },
  };
}

function writeCodexDraft(target, message, options = {}) {
  return createCodexWriter(options).write(target, message);
}

function verifyCodexDraft(target, message, options = {}) {
  if (!String(message || '').trim()) {
    return Promise.resolve({ ok: false, code: 'EMPTY_MESSAGE', reason: '消息不能为空' });
  }
  return runCodexUiAutomation('verify-draft', target, message, options);
}

function verifyCodexDesktopSession(target, options = {}) {
  return runCodexUiAutomation('verify-session', target, '', options);
}

function sendCodexMessage(target, context = {}, options = {}) {
  return createCodexWriter(options).send(target, context);
}

module.exports = {
  buildCodexUiAutomationScript() {
    return CODEX_UIA_SCRIPT;
  },
  createCodexWriter,
  runCodexUiAutomation,
  writeCodexDraft,
  verifyCodexDraft,
  verifyCodexDesktopSession,
  sendCodexMessage,
  sessionTitleMatchKind,
};
