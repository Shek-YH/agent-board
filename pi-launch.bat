@echo off
:: Launch Pi Web UI (http://127.0.0.1:3210) and open browser.
:: If the server is already running, just open the browser.
:: Use full System32 paths: Git Bash's PATH may shadow timeout/netstat/findstr.

set "URL=http://127.0.0.1:3210"
set "TO=%SystemRoot%\System32\timeout.exe"

rem Strip WorkBuddy safe-delete shim from NODE_OPTIONS: it intercepts pi's
rem trash call on settings.json.lock and hangs pi startup (ETIMEDOUT).
set "NODE_OPTIONS="
set "CODEBUDDY_SAFE_DELETE_BULK_GUARD="
set "CODEBUDDY_SAFE_DELETE_BULK_STATE_DIR="
set "CODEBUDDY_TOOL_CALL_ID="

%SystemRoot%\System32\netstat.exe -ano 2>nul | %SystemRoot%\System32\findstr.exe ":3210" | %SystemRoot%\System32\findstr.exe "LISTENING" >nul
if not errorlevel 1 (
  start "" "%URL%"
  exit /b 0
)

rem Start pi-web-ui in the background (minimized).
start "" /min "D:\Program Files\node-v22.14.0-win-x64\node_global\pi-web-ui.cmd"

rem Wait for the server to come up.
%TO% /t 6 /nobreak >nul

rem Open the default browser.
start "" "%URL%"
exit /b 0
