@echo off
setlocal

set "LAUNCHER=%~dp0launch.vbs"
if not exist "%LAUNCHER%" exit /b 1

"%SystemRoot%\System32\wscript.exe" //nologo "%LAUNCHER%"
exit /b 0
