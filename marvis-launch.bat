@echo off
:: Launch Marvis UI (latest version dir). No for/dir loops to keep cmd happy.
:: If the pinned Marvis.exe is missing, fall back to the official launcher.

if exist "F:\Program Files\Tencent\Marvis\Application\1.60.2200.168\Marvis.exe" (
  start "" "F:\Program Files\Tencent\Marvis\Application\1.60.2200.168\Marvis.exe"
  exit /b 0
)
if exist "F:\Program Files\Tencent\Marvis\Application\1.60.2100.152\Marvis.exe" (
  start "" "F:\Program Files\Tencent\Marvis\Application\1.60.2100.152\Marvis.exe"
  exit /b 0
)
start "" "F:\Program Files\Tencent\Marvis\Application\MarvisLauncher.exe"