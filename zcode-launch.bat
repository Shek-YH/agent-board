@echo off
:: Launch ZCode desktop app
if exist "C:\Users\Administrator\AppData\Local\ZCode\ZCode.exe" (
  start "" "C:\Users\Administrator\AppData\Local\ZCode\ZCode.exe"
  exit /b 0
)
