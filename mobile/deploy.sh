#!/system/bin/sh
# 手机容器里一键更新：解压离线包 → 重启 server/bridge → 自检
# 用法（DSHA 终端）：sh /root/nest-local/deploy.sh
# 前提：离线包已推到 /sdcard/Download/nest/nest-offline.tar.gz
BASE=/root/nest-local
PKG=/sdcard/Download/nest/nest-offline.tar.gz
LOG=$BASE/data/deploy.log
mkdir -p "$BASE/data"
{
  echo "=== $(date '+%F %T') 开始更新 ==="
  [ -f "$BASE/data" ] && cp -f "$BASE/data/nest.db" "$BASE/data/nest.db.bak" 2>/dev/null
  tar xzf "$PKG" -C "$BASE" || { echo "解压失败"; exit 1; }
  pkill -f 'server/index.mjs'
  pkill -f 'nest-bridge.mjs'
  sleep 1
  sh "$BASE/start.sh"
  sleep 7
  echo -n "HTTP:"; curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/api/server-info; echo
  echo "=== $(date '+%F %T') 完成 ==="
} >> "$LOG" 2>&1
tail -6 "$LOG"
