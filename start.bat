@echo off
setlocal
title Agent Board - AI 会话看板
cd /d "%~dp0"

set "NODE_EXE=%~dp0runtime\node.exe"
if not exist "%NODE_EXE%" (
  where node >nul 2>&1
  if errorlevel 1 (
    echo 未找到项目内置 runtime\node.exe，也未找到 PATH 中的 Node.js。
    echo 请安装 Node.js 或把 node.exe 加入 PATH 后重试。
    pause
    exit /b 1
  )
  set "NODE_EXE=node"
)

echo 正在启动 Agent Board...
echo 启动后请在浏览器打开: http://127.0.0.1:4876
echo 关闭本窗口即停止服务。
echo.
"%NODE_EXE%" server.js
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" echo Agent Board 已退出，退出码：%EXIT_CODE%
pause
exit /b %EXIT_CODE%
