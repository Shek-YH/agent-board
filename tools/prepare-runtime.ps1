param(
  [string]$Source = '',
  [string]$Destination = (Join-Path $PSScriptRoot '..\runtime\node.exe'),
  [string]$ExpectedVersion = 'v22.22.2'
)

$ErrorActionPreference = 'Stop'
$destinationDir = Split-Path -Parent $Destination
$projectRuntime = Join-Path $destinationDir 'node.exe'
$candidates = @()
if ($Source.Trim()) { $candidates += $Source }
if (Test-Path -LiteralPath $projectRuntime -PathType Leaf) { $candidates += $projectRuntime }
if ($env:AGENT_BOARD_NODE_SOURCE) { $candidates += $env:AGENT_BOARD_NODE_SOURCE }
if ($env:AGENT_BOARD_NODE_RUNTIME) { $candidates += $env:AGENT_BOARD_NODE_RUNTIME }
$pathNode = Get-Command node.exe -ErrorAction SilentlyContinue
if ($pathNode) { $candidates += $pathNode.Source }

$resolvedSource = $null
foreach ($candidate in ($candidates | Select-Object -Unique)) {
  if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
  $version = (& $candidate --version 2>$null | Select-Object -First 1).Trim()
  if ($version -eq $ExpectedVersion) {
    $resolvedSource = (Resolve-Path -LiteralPath $candidate).Path
    break
  }
}
if (-not $resolvedSource) {
  throw "Node runtime $ExpectedVersion not found. Put the official runtime at $projectRuntime or set AGENT_BOARD_NODE_SOURCE."
}
New-Item -ItemType Directory -Force -Path $destinationDir | Out-Null
$resolvedDestination = (Resolve-Path -LiteralPath $destinationDir).Path | Join-Path -ChildPath (Split-Path -Leaf $Destination)
if ($resolvedSource -ne $resolvedDestination) {
  Copy-Item -LiteralPath $resolvedSource -Destination $resolvedDestination -Force
}
Write-Output "Prepared $resolvedDestination from $resolvedSource ($ExpectedVersion)"
