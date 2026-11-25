#!/bin/sh
# Nest 本地世界看门狗：每 60 秒探一次 8787，挂了就重新执行 start.sh。
# 装法：放到 /root/nest-local/watchdog.sh，并在 start.sh 末尾加：
#   pgrep -f watchdog.sh >/dev/null || nohup sh /root/nest-local/watchdog.sh >/dev/null 2>&1 &
# 注意：容器本身被系统结束（DSHA 会话结束）时看门狗也会一起没了，
#       那种情况靠 DSH 启动钩子（bin.js 里的 NEST_AUTOSTART）在下次启动时拉起。
BASE=/root/nest-local
LOG=$BASE/data/watchdog.log
mkdir -p "$BASE/data"
while true; do
  if ! curl -sf -m 5 -o /dev/null http://127.0.0.1:8787/api/server-info; then
    echo "$(date '+%F %T') 探活失败，执行 start.sh" >> "$LOG"
    sh "$BASE/start.sh" >> "$LOG" 2>&1
  fi
  sleep 60
done