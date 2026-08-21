#!/usr/bin/env bash
cd "$(dirname "$0")"
echo "正在启动 Agent Board..."
echo "启动后请在浏览器打开: http://127.0.0.1:4876"
echo
if command -v node >/dev/null 2>&1; then
  node server.js
else
  "C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2/node.exe" server.js
fi
