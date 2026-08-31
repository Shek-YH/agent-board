param(
  [string]$TargetPath = (Join-Path $PSScriptRoot 'fixtures\autopilot-intake-target.txt')
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $TargetPath -PathType Leaf)) {
  Write-Error "Smoke target not found: $TargetPath"
  exit 1
}

$content = Get-Content -LiteralPath $TargetPath -Raw
if ($content -notmatch '(?m)^status:\s*ready\s*$') {
  Write-Error 'Expected status: ready'
  exit 1
}
if ($content -notmatch '(?m)^label:\s*AUTOPILOT_READY\s*$') {
  Write-Error 'Expected label: AUTOPILOT_READY'
  exit 1
}

Write-Output "AutoPilot Intake smoke target verified: $TargetPath"
