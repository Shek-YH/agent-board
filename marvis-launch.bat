@echo off
:: Launch Marvis UI from common per-user or machine-wide install locations.
setlocal

for %%R in ("%LOCALAPPDATA%\Tencent\Marvis" "%ProgramFiles%\Tencent\Marvis" "%ProgramFiles(x86)%\Tencent\Marvis") do (
  if exist "%%~R\Application\MarvisLauncher.exe" (
    start "" "%%~R\Application\MarvisLauncher.exe"
    exit /b 0
  )
  for /f "delims=" %%V in ('dir /b /ad /o-n "%%~R\Application" 2^>nul') do (
    if exist "%%~R\Application\%%V\Marvis.exe" (
      start "" "%%~R\Application\%%V\Marvis.exe"
      exit /b 0
    )
  )
)
exit /b 1
