@echo off
title Agent Board - AI 会话看板
cd /d "%~dp0"
echo 正在启动 Agent Board...
echo 启动后请在浏览器打开: http://127.0.0.1:4876
echo 关闭本窗口即停止服务。
echo.
node server.js
pause
