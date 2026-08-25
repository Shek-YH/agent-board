@echo off
:: Launch ZCode desktop app
if exist "%LOCALAPPDATA%\ZCode\ZCode.exe" (
  start "" "%LOCALAPPDATA%\ZCode\ZCode.exe"
  exit /b 0
)
exit /b 1
