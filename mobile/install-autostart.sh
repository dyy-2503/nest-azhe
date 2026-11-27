#!/system/bin/sh
# 在手机容器里安装「本地世界自启」
#
# 做的事：
#   1. 把桥接钥匙存到 data/ai-key.txt（从正在跑的桥接进程命令行里取，不重新发钥匙）
#   2. 写 /root/nest-local/start.sh
#   3. 在 DSH 启动时会 --require 的 dns-compat.cjs 末尾挂一段钩子：
#      DSH 一起来就把本地服务器 + 桥接拉起来
#   4. 立刻跑一次 start.sh 验证
#
# 用法（在手机 DSHA 的终端里）：
#   sh /sdcard/Download/nest/install-autostart.sh

BASE=/root/nest-local
HOOK=/usr/local/share/dsha/dns-compat.cjs

cd "$BASE" || { echo "找不到 $BASE（先跑 go.sh）"; exit 1; }

# ---- 1. 钥匙 ----
if [ ! -s data/ai-key.txt ]; then
  PID=$(pgrep -f "[n]est-bridge.mjs --server http://127.0.0.1" | head -1)
  if [ -n "$PID" ]; then
    tr '\0' ' ' < /proc/$PID/cmdline | sed -n 's/.*--key \([^ ]*\).*/\1/p' > data/ai-key.txt
    chmod 600 data/ai-key.txt
  fi
fi
if [ -s data/ai-key.txt ]; then
  echo "[1] 钥匙已保存（$(wc -c < data/ai-key.txt) 字节）"
else
  echo "[1] 没有找到钥匙：data/ai-key.txt 为空，桥接不会自启"
fi

# ---- 2. start.sh ----
SRC=""
[ -f "$BASE/phone-start.sh" ] && SRC="$BASE/phone-start.sh"
[ -z "$SRC" ] && [ -f /sdcard/Download/nest/phone-start.sh ] && SRC=/sdcard/Download/nest/phone-start.sh
if [ -n "$SRC" ]; then
  cp "$SRC" start.sh
  echo "[2] 复制 start.sh（来自 $SRC）"
elif [ ! -f start.sh ]; then
  echo "[2] 没有 phone-start.sh，包不完整"
  exit 1
else
  echo "[2] 沿用已有的 start.sh"
fi
chmod +x start.sh

# ---- 3. DSH 启动钩子 ----
if [ ! -w "$HOOK" ]; then
  echo "[3] 钩子文件不可写：$HOOK（DSH 版本不同？）"
else
  if grep -q 'NEST_LOCAL_AUTOSTART' "$HOOK" 2>/dev/null; then
    echo "[3] 钩子已存在，跳过"
  else
    cat >> "$HOOK" <<'HOOKEOF'

// NEST_LOCAL_AUTOSTART: DSH 启动时顺手把手机本地世界（Nest 服务器 + 桥接）拉起来
try {
  if (!process.env.NEST_NO_AUTOSTART) {
    require('node:child_process').spawn('/bin/sh', ['/root/nest-local/start.sh'], { detached: true, stdio: 'ignore' }).unref();
  }
} catch (_) { /* 自启失败不能影响 DSH 本体 */ }
HOOKEOF
    echo "[3] 钩子已加到 $HOOK"
  fi
fi

# ---- 4. 验证 ----
rm -f data/.start.lock
sh start.sh
sleep 4
if curl -s -m 3 http://127.0.0.1:8787/api/server-info > /dev/null 2>&1; then
  echo "[4] 服务器 OK"
else
  echo "[4] 服务器没起来，看 data/server.log"
fi
if pgrep -f "[n]est-bridge.mjs --server http://127.0.0.1:8787" > /dev/null 2>&1; then
  echo "[5] 桥接 OK"
else
  echo "[5] 桥接没起来，看 data/bridge.log"
fi
