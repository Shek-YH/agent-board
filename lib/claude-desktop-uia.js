'use strict';

const { spawn, spawnSync } = require('child_process');

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

function isClaudeDesktopRunning(options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== 'win32') return false;
  const executable = options.executable || resolvePowerShellExecutable();
  const spawnSyncImpl = options.spawnSync || spawnSync;
  const result = spawnSyncImpl(executable, [
    '-NoProfile', '-NonInteractive', '-Command',
    "@(Get-Process -Name 'claude' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }).Count -gt 0",
  ], { windowsHide: true, encoding: 'utf8' });
  return result && result.status === 0 && /^\s*True\s*$/i.test(result.stdout || '');
}

const CLAUDE_UIA_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class AgentBoardClaudeWindow {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  public static void ActivateWindow(IntPtr h) {
    // SW_RESTORE 会把最大化窗口恢复成普通窗口，导致点击跳转后 Claude
    // 从最大化变成小窗口；只有最小化时才恢复，最大化时保留最大化状态。
    if (IsIconic(h)) ShowWindow(h, 9);
    else if (IsZoomed(h)) ShowWindow(h, 3);
    SetForegroundWindow(h);
    BringWindowToTop(h);
  }
}
'@
$desktopId = $env:AGENT_BOARD_CLAUDE_DESKTOP_SESSION_ID
$title = $env:AGENT_BOARD_CLAUDE_TITLE
$cwd = $env:AGENT_BOARD_CLAUDE_CWD

function Invoke-Element($element) {
  $pattern = $null
  if ($element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
    $pattern.Invoke()
    return $true
  }
  if ($element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern)) {
    $pattern.Select()
    return $true
  }
  return $false
}

function Find-Session($root) {
  $all = $root.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.Condition]::TrueCondition
  )
  $idMatches = @()
  $exactTitleMatches = @()
  $normalizedTitleMatches = @()
  $titlePrefix = if ($title -and $title.Length -gt 24) { $title.Substring(0, 24) } else { $title }
  $prefixTitleMatches = @()
  foreach ($element in $all) {
    $info = $element.Current
    $searchText = (($info.Name, $info.AutomationId, $info.HelpText) -join ' ')
    $normalizedName = $info.Name -replace '^(Idle|Unread response|Error)\s+', ''
    if ($desktopId -and $searchText.Contains($desktopId)) {
      $idMatches += $element
    } elseif ($title -and $info.Name -eq $title) {
      $exactTitleMatches += $element
    } elseif ($title -and $normalizedName -eq $title) {
      $normalizedTitleMatches += $element
    } elseif ($titlePrefix -and $normalizedName.StartsWith($titlePrefix)) {
      $prefixTitleMatches += $element
    }
  }
  $matches = if ($idMatches.Count -gt 0) { $idMatches } elseif ($exactTitleMatches.Count -gt 0) { $exactTitleMatches } elseif ($normalizedTitleMatches.Count -gt 0) { $normalizedTitleMatches } else { $prefixTitleMatches }
  if ($matches.Count -eq 1) { return @{ status = 'OK'; element = $matches[0] } }
  if ($matches.Count -gt 1) { return @{ status = 'AMBIGUOUS' } }
  return @{ status = 'NOT_FOUND' }
}

function Get-ClaudeWindows($process) {
  $roots = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
    [System.Windows.Automation.TreeScope]::Children,
    [System.Windows.Automation.Condition]::TrueCondition
  )
  $windows = @($roots | Where-Object { $_.Current.ProcessId -eq $process.Id })
  if ($windows.Count -gt 0) { return $windows }
  $main = [System.Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
  if ($main) { return @($main) }
  return @()
}

for ($attempt = 0; $attempt -lt 20; $attempt++) {
  $process = Get-Process -Name 'claude' | Where-Object { $_.MainWindowHandle -ne 0 } | Sort-Object StartTime -Descending | Select-Object -First 1
  if ($process) {
    $windows = @(Get-ClaudeWindows $process)
    $codeWindow = $windows | Where-Object { $_.Current.Name -eq 'Code' } | Select-Object -First 1
    if (-not $codeWindow) {
      $mainWindow = [System.Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
      if ($mainWindow) {
        $codeCondition = New-Object System.Windows.Automation.PropertyCondition(
          [System.Windows.Automation.AutomationElement]::NameProperty, 'Code'
        )
        $code = $mainWindow.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $codeCondition)
        if ($code) { [void](Invoke-Element $code); Start-Sleep -Milliseconds 120 }
      }
      $windows = @(Get-ClaudeWindows $process)
      $codeWindow = $windows | Where-Object { $_.Current.Name -eq 'Code' } | Select-Object -First 1
    }
    foreach ($window in $windows) {
      $result = Find-Session $window
      if ($result.status -eq 'OK') {
        $handle = [IntPtr]$window.Current.NativeWindowHandle
        if ($handle -ne [IntPtr]::Zero) {
          [AgentBoardClaudeWindow]::ActivateWindow($handle)
          Start-Sleep -Milliseconds 60
        }
        if (Invoke-Element $result.element) { Write-Output 'DONE:OK' } else { Write-Output 'DONE:INVOKE_FAILED' }
        exit
      }
      if ($result.status -eq 'AMBIGUOUS') { Write-Output 'DONE:AMBIGUOUS'; exit }
    }
  }
  Start-Sleep -Milliseconds 100
}
Write-Output 'DONE:NOT_FOUND'
`;

function buildClaudeUiAutomationScript() {
  return CLAUDE_UIA_SCRIPT;
}

function focusClaudeSessionWithUiAutomation(target, options = {}) {
  if (!target || !target.desktopSessionId) {
    return Promise.resolve({ status: 'skipped' });
  }
  const platform = options.platform || process.platform;
  if (platform !== 'win32') return Promise.resolve({ status: 'unsupported' });
  const spawnImpl = options.spawn || spawn;
  const executable = options.executable || resolvePowerShellExecutable();
  const child = spawnImpl(executable, [
    '-NoProfile', '-NonInteractive', '-Command', CLAUDE_UIA_SCRIPT,
  ], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      AGENT_BOARD_CLAUDE_DESKTOP_SESSION_ID: target.desktopSessionId,
      AGENT_BOARD_CLAUDE_TITLE: target.title || '',
      AGENT_BOARD_CLAUDE_CWD: target.cwd || '',
    },
  });
  return new Promise((resolve) => {
    let output = '';
    let errorOutput = '';
    let settled = false;
    let timeout = null;
    const finish = (statusOverride) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      const match = output.match(/DONE:([A-Z_]+)/);
      resolve({
        status: statusOverride || (match ? match[1].toLowerCase() : 'unknown'),
        ...(errorOutput.trim() ? { error: errorOutput.trim() } : {}),
      });
    };
    if (child.stdout && typeof child.stdout.on === 'function') child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    if (child.stderr && typeof child.stderr.on === 'function') child.stderr.on('data', (chunk) => { errorOutput += chunk.toString(); });
    if (typeof child.once === 'function') {
      child.once('close', () => finish());
      const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 5000;
      timeout = setTimeout(() => {
        try { child.kill?.(); } catch {}
        finish('timeout');
      }, timeoutMs);
    } else finish();
  });
}

module.exports = { buildClaudeUiAutomationScript, focusClaudeSessionWithUiAutomation, isClaudeDesktopRunning };
