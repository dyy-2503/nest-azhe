#!/system/bin/sh
# 手机本地世界：把 Nest 服务器和桥接拉起来（幂等，重复执行安全）
#
# 由 DSH 启动钩子调用（见 install-autostart.sh），也可以手动执行：
#   sh /root/nest-local/start.sh

BASE=/root/nest-local
cd "$BASE" || exit 0

# 容器里没有 tzdata 时，靠这个让时间和日志走东八区
export TZ=Asia/Shanghai
mkdir -p data

# 30 秒内只执行一次，避免 DSH 启动时多个 node 进程同时触发
LOCK=$BASE/data/.start.lock
NOW=$(date +%s)
if [ -f "$LOCK" ]; then
  LAST=$(cat "$LOCK" 2>/dev/null || echo 0)
  [ $((NOW - LAST)) -lt 30 ] && exit 0
fi
echo "$NOW" > "$LOCK"

# ---- 1. Nest 服务器 ----
if ! curl -s -m 2 http://127.0.0.1:8787/api/server-info > /dev/null 2>&1; then
  NEST_DATA_DIR="$BASE/data" NEST_PORT=8787 nohup node server/index.mjs >> data/server.log 2>&1 &
  sleep 2
fi

# ---- 2. 桥接（把本机 DSH 接到本机服务器；钥匙在 data/ai-key.txt）----
KEY=$(cat data/ai-key.txt 2>/dev/null)
if [ -n "$KEY" ]; then
  if ! pgrep -f "[n]est-bridge.mjs --server http://127.0.0.1:8787" > /dev/null 2>&1; then
    nohup node bridge/nest-bridge.mjs \
      --server http://127.0.0.1:8787 \
      --key "$KEY" \
      --dsh http://127.0.0.1:3080 \
      >> data/bridge.log 2>&1 &
  fi
fi

# ---- 3. 看门狗（每 60 秒探活，挂了自动再跑本脚本）----
if [ -f "$BASE/watchdog.sh" ] && ! pgrep -f "watchdog.sh" > /dev/null 2>&1; then
  nohup sh "$BASE/watchdog.sh" >> data/watchdog.log 2>&1 &
fi
