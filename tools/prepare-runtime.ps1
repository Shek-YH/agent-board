param(
  [string]$Source = "$env:USERPROFILE\.workbuddy\binaries\node\versions\22.22.2\node.exe",
  [string]$Destination = "$PSScriptRoot\..\runtime\node.exe"
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) {
  throw "Node 22.22.2 runtime not found: $Source"
}
$destinationDir = Split-Path -Parent $Destination
New-Item -ItemType Directory -Force -Path $destinationDir | Out-Null
Copy-Item -LiteralPath $Source -Destination $Destination -Force
Write-Output "Prepared $Destination"
