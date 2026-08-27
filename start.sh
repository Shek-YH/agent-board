#!/usr/bin/env bash
set -e
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$SCRIPT_DIR"
echo "正在启动 Agent Board..."
echo "启动后请在浏览器打开: http://127.0.0.1:4876"
echo
NODE_EXE="$SCRIPT_DIR/runtime/node"
if [ ! -x "$NODE_EXE" ]; then
  NODE_EXE="$(command -v node || true)"
fi
if [ -n "$NODE_EXE" ]; then
  exec "$NODE_EXE" "$SCRIPT_DIR/server.js"
else
  echo "未找到 Node.js，请先安装 Node.js 22+ 或将 node 加入 PATH。" >&2
  exit 1
fi
