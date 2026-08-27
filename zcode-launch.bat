@echo off
:: Launch ZCode desktop app from the machine's actual installation root.
for %%P in (
  "%LOCALAPPDATA%\ZCode\ZCode.exe"
  "%LOCALAPPDATA%\Programs\ZCode\ZCode.exe"
  "%LOCALAPPDATA%\Programs\ZCode\app-*\ZCode.exe"
  "%ProgramFiles%\ZCode\ZCode.exe"
  "%ProgramFiles%\zcode\ZCode.exe"
  "%ProgramFiles(x86)%\ZCode\ZCode.exe"
  "%ProgramFiles(x86)%\zcode\ZCode.exe"
  "D:\Program Files\ZCode\ZCode.exe"
  "D:\Program Files\zcode\ZCode.exe"
) do if exist "%%~P" (
  start "" "%%~P"
  exit /b 0
)
exit /b 1
