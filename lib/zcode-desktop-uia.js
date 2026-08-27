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

const ZCODE_UIA_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class AgentBoardZCodeWindow {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  public const uint LeftDown = 0x0002;
  public const uint LeftUp = 0x0004;
  public static void ActivateWindow(IntPtr h) {
    if (IsIconic(h)) ShowWindow(h, 9);
    else if (IsZoomed(h)) ShowWindow(h, 3);
    SetForegroundWindow(h);
    BringWindowToTop(h);
  }
  public static void Click(double x, double y) {
    SetCursorPos((int)Math.Round(x), (int)Math.Round(y));
    mouse_event(LeftDown, 0, 0, 0, UIntPtr.Zero);
    mouse_event(LeftUp, 0, 0, 0, UIntPtr.Zero);
  }
}
'@
$title = $env:AGENT_BOARD_ZCODE_TITLE
$cwd = $env:AGENT_BOARD_ZCODE_CWD

function Normalize-TaskTitle($value) {
  if (-not $value) { return '' }
  $text = [string]$value
  $text = $text -replace '\s*\d+\s*(秒|分钟|小时|天|周|个月|月|年)(前)?\s*$', ''
  return (($text -replace '\s+', ' ').Trim())
}

function Find-ZCodeTask($root) {
  if (-not $title) { return @{ status = 'NOT_FOUND' } }
  $wanted = Normalize-TaskTitle $title
  $all = $root.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.Condition]::TrueCondition
  )
  $exact = @()
  $prefix = @()
  foreach ($element in $all) {
    $info = $element.Current
    if ($info.ControlType.ProgrammaticName -ne 'ControlType.ListItem') { continue }
    if ($info.ClassName -notlike '*group/task-item*') { continue }
    $actual = Normalize-TaskTitle $info.Name
    if ($actual -eq $wanted) { $exact += $element }
    elseif ($wanted.Length -ge 24 -and $actual.StartsWith($wanted.Substring(0, 24))) { $prefix += $element }
  }
  $matches = if ($exact.Count -gt 0) { $exact } else { $prefix }
  if ($matches.Count -eq 1) { return @{ status = 'OK'; element = $matches[0] } }
  if ($matches.Count -gt 1) { return @{ status = 'AMBIGUOUS' } }
  return @{ status = 'NOT_FOUND' }
}

function Get-ZCodeWindows($process) {
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

$process = Get-Process -Name 'ZCode' | Where-Object { $_.MainWindowHandle -ne 0 } | Sort-Object StartTime -Descending | Select-Object -First 1
if (-not $process) { Write-Output 'DONE:NOT_FOUND'; exit }
$windows = @(Get-ZCodeWindows $process)
foreach ($window in $windows) {
  $result = Find-ZCodeTask $window
  if ($result.status -eq 'OK') {
    $handle = [IntPtr]$window.Current.NativeWindowHandle
    if ($handle -eq [IntPtr]::Zero) { $handle = [IntPtr]$process.MainWindowHandle }
    if ($handle -ne [IntPtr]::Zero) { [AgentBoardZCodeWindow]::ActivateWindow($handle) }
    $b = $result.element.Current.BoundingRectangle
    if ($b.Width -gt 0 -and $b.Height -gt 0) {
      [AgentBoardZCodeWindow]::Click($b.X + ($b.Width / 2), $b.Y + ($b.Height / 2))
      Write-Output 'DONE:OK'
    } else { Write-Output 'DONE:INVOKE_FAILED' }
    exit
  }
  if ($result.status -eq 'AMBIGUOUS') { Write-Output 'DONE:AMBIGUOUS'; exit }
}
Write-Output 'DONE:NOT_FOUND'
`;

function buildZCodeUiAutomationScript() {
  return ZCODE_UIA_SCRIPT;
}

function focusZCodeSessionWithUiAutomation(target, options = {}) {
  if (!target || !target.title) return Promise.resolve({ status: 'skipped' });
  const platform = options.platform || process.platform;
  if (platform !== 'win32') return Promise.resolve({ status: 'unsupported' });
  const spawnImpl = options.spawn || spawn;
  const executable = options.executable || resolvePowerShellExecutable();
  const child = spawnImpl(executable, [
    '-NoProfile', '-NonInteractive', '-Command', ZCODE_UIA_SCRIPT,
  ], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      AGENT_BOARD_ZCODE_TITLE: target.title || '',
      AGENT_BOARD_ZCODE_CWD: target.cwd || '',
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
      const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 12000;
      timeout = setTimeout(() => {
        try { child.kill?.(); } catch {}
        finish('timeout');
      }, timeoutMs);
    } else finish();
  });
}

module.exports = { buildZCodeUiAutomationScript, focusZCodeSessionWithUiAutomation };
