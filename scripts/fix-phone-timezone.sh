#!/bin/sh
# 手机容器（DSHA 的 Ubuntu）时区修复
# 问题：容器里没有 tzdata，/usr/share/zoneinfo 缺 Asia/Shanghai，
#       所以容器 date / 服务日志 / AI 眼里的时间都是 UTC，比本地慢 8 小时。
# 做法：把一份真实的 Asia/Shanghai TZif 文件放进去 + 设 /etc/localtime + /etc/timezone。
# 用法（手机容器终端里，root）：
#   adb push <本机zoneinfo>/Asia/Shanghai /sdcard/Download/nest/tz/Shanghai
#   sh /sdcard/Download/nest/fix-phone-timezone.sh /sdcard/Download/nest/tz/Shanghai
set -e
SRC="${1:-/sdcard/Download/nest/tz/Shanghai}"
if [ ! -f "$SRC" ]; then
  echo "找不到时区文件: $SRC"
  echo "先在电脑上：python -m pip install tzdata，再 push 站点包里的 zoneinfo/Asia/Shanghai"
  exit 1
fi
mkdir -p /usr/share/zoneinfo/Asia
cp "$SRC" /usr/share/zoneinfo/Asia/Shanghai
ln -sf /usr/share/zoneinfo/Asia/Shanghai /etc/localtime
echo "Asia/Shanghai" > /etc/timezone
START=/root/nest-local/start.sh
if [ -f "$START" ] && ! grep -q 'export TZ=Asia/Shanghai' "$START"; then
  sed -i '1i export TZ=Asia/Shanghai' "$START"
fi
echo "--- 现在 ---"
date
TZ=Asia/Shanghai node -e "console.log('node:', new Date().toString())" 2>/dev/null || true
echo "--- 重启 Nest 服务与桥接 ---"
pkill -f 'server/index.mjs' 2>/dev/null || true
pkill -f 'nest-bridge.mjs' 2>/dev/null || true
sleep 1
sh "$START"