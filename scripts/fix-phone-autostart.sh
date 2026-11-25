#!/bin/sh
# 让 Nest 本地世界跟着 DSHA/DSH 一起起来（手机自启动钩子）
# 原理：给 dsh 的入口文件（/usr/local/bin/dsh -> …/dsh/lib/bin.js）加一段 preload：
#       只要 dsh 以 web 子命令启动，就顺手 spawn /root/nest-local/start.sh。
# 用法（手机容器终端，root）：sh /sdcard/Download/nest/fix-phone-autostart.sh
set -e
F=/usr/local/bin/dsh
TARGET=$(readlink -f "$F" 2>/dev/null || echo "$F")
echo "dsh 入口: $F -> $TARGET"
[ -f /root/dsh.orig ] || cp "$TARGET" /root/dsh.orig
node /sdcard/Download/nest/patch-dsh.mjs
sha256sum "$TARGET"
grep -c NEST_AUTOSTART "$TARGET" || true
echo "done（重启一次 DSHA 生效）"