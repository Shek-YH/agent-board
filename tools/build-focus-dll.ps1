$ErrorActionPreference = 'Stop'
$output = Join-Path $PSScriptRoot 'wf.dll'
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
if (Test-Path -LiteralPath $output) { Remove-Item -LiteralPath $output -Force }
Add-Type -TypeDefinition $source -OutputAssembly $output
if (-not (Test-Path -LiteralPath $output -PathType Leaf)) { throw "wf.dll was not generated: $output" }
Write-Output "Built $output"
