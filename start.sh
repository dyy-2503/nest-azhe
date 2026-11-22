#!/usr/bin/env bash
# Nest 启动器（macOS / Linux）：chmod +x start.sh 之后 ./start.sh
# 需要 Node 22.5 以上
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "没找到 Node。请先安装：https://nodejs.org/"
  exit 1
fi

exec node --no-warnings scripts/start.mjs "$@"
