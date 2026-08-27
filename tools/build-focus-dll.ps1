$ErrorActionPreference = 'Stop'
$output = Join-Path $PSScriptRoot 'wf.dll'
$temporaryOutput = Join-Path $PSScriptRoot ("wf.$PID.$([guid]::NewGuid().ToString('N')).dll")
$source = @'
using System;
using System.Runtime.InteropServices;
public class WF {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte s, uint f, UIntPtr e);
}
'@
try {
  Add-Type -TypeDefinition $source -OutputAssembly $temporaryOutput
  if (-not (Test-Path -LiteralPath $temporaryOutput -PathType Leaf)) {
    throw "wf.dll was not generated: $temporaryOutput"
  }

  try {
    Move-Item -LiteralPath $temporaryOutput -Destination $output -Force -ErrorAction Stop
    Write-Output "Built $output"
  } catch {
    $existing = Get-Item -LiteralPath $output -ErrorAction SilentlyContinue
    if ($existing -and $existing.Length -gt 0) {
      Write-Warning "wf.dll is locked; keeping the existing artifact: $output"
    } else {
      throw
    }
  }
} finally {
  if (Test-Path -LiteralPath $temporaryOutput) {
    Remove-Item -LiteralPath $temporaryOutput -Force -ErrorAction SilentlyContinue
  }
}
