@echo off
setlocal
title Agent Board 守护进程
cd /d "%~dp0"
if exist "%~dp0runtime\node.exe" (
  "%~dp0runtime\node.exe" "%~dp0agent-board-watchdog.js"
) else (
  node "%~dp0agent-board-watchdog.js"
)
