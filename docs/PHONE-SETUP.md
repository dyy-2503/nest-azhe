# 手机本地世界：安装与调整说明

> 这份文档写给"想再装一台"或"出问题要排查"的人。当前实测机器：vivo V2408A / Android 16，
> 组合版本：DSHA `0.2.21-20261009.0750-dsh0.2.0-rc.2`（内置 DSH 0.2.0-rc.2、Ubuntu 10、proot）、
> Nest `0.7.1`、端口 `8787`（Nest）/ `3080`（DSH web）。

## 0. 这套东西靠什么跑

```
Nest App（Capacitor 壳，app.nest.chat）
   │  打开 http://127.0.0.1:8787
   ▼
DSHA 里的 Ubuntu 容器（proot，由 DSHA App 提供）
   ├─ Nest server      node server/index.mjs   :8787   —— 聊天/记忆/媒体
   ├─ Nest bridge      node bridge/nest-bridge.mjs      —— 把消息转给本机 DSH，把 AI 回复转回来
   ├─ watchdog.sh                                        —— 每 60 秒探活，挂了自动拉起
   └─ DSH web          dsh web --host 127.0.0.1 :3080   —— AI 本体
```

| 组件 | 必需？ | 作用 | 来源 |
|---|---|---|---|
| Android 11+ / arm64 | 必需 | 跑 DSHA | 系统自带 |
| **DSHA**（`com.dsh.client`） | **必需** | 提供 Ubuntu 容器 + DSH web（AI 本体） | GitHub [DSH-APP/DSHA Releases](https://github.com/DSH-APP/DSHA/releases) |
| **Nest 离线包** | **必需** | `server`/`bridge`/`public`/`start.sh` | 本仓库 `dist/nest-offline.tar.gz` |
| **Android 省电/自启动设置** | **必需** | 防止容器被系统掐 | 手机设置 |
| Shizuku | 可选 | 给 DSHA 加"设备能力"（ADB 级权限），**Nest 本身不依赖** | GitHub [RikkaApps/Shizuku](https://github.com/RikkaApps/Shizuku) |
| ADB / USB 调试 | 可选 | 只用于从电脑推包、看日志、调试 | Android SDK platform-tools |

## 1. 安装 DSHA

1. 到 **https://github.com/DSH-APP/DSHA/releases** 下载 APK（本机装的是 v0.2.0-rc2 / build170，文件名形如 `dsha-0.2.0-rc2.apk`；另有"兼容版"给 Android 6+）。
   - 下载后建议核对 release 页给的 **SHA-256**：
     ```powershell
     (Get-FileHash .\dsha-0.2.0-rc2.apk -Algorithm SHA256).Hash
     ```
     ```sh
     sha256sum dsha.apk
     ```
   - "标准版"和"兼容版"共用包名 `com.dsh.client`，**不能并排安装**，换版先卸载。
2. 手机上允许"安装未知来源应用"→ 安装。
3. 首次启动会解压 Ubuntu 环境（APK 约 300MB，解压后占 1.5GB+），等它自己完成。
4. 进 **启动** 页 → 点「**启动 DSHA**」→ 等状态变成「**DSH 已就绪，可进入**」→ 实际 Web 端口应为 `3080`。

> ⚠️ DSHA 升级会重装它自带的 `@deepseek-ai/dsh` 包，**会冲掉 Nest 的自启动钩子**（见 4.3）。
> 升级完必须重新装一次钩子，否则重启 DSHA 后世界不会自己起来。

## 2. DSHA 里必须调的设置

| 位置 | 设置 | 为什么 |
|---|---|---|
| 设置 → 使用体验 | **省电模式：关闭**（= 持续保持运行） | 开着时切到别的 App 约 10 秒容器就被冻住，本地世界直接不可达 |
| 设置 → 接口与运行配置 | 运行方式 `proot`（默认）、首选 Web 端口 `3080` | 和文档/脚本里写的端口保持一致 |
| 启动页 | 「启动 / 重启 / 停止」三个按钮 | 出问题时先点「重启」 |
| 终端页 | ＋新建 可进容器 shell | 排障用 |

> 「省电模式」改完 **必须重启一次 DSHA 才生效**（这是当初排查了两天才发现的坑）。

## 3. Android 系统设置（必需）

以 vivo OriginOS 为例（其他品牌对应项名字略有不同）：

1. **电池 → 后台耗电管理 → DSHA → 允许后台耗电**
   （默认"智能控制"会在锁屏一段时间后限制它，表现为锁屏后世界断掉）
2. **i管家 / 设置 → 权限管理 → 自启动 → 允许 DSHA**
3. 最近任务里 **锁定 DSHA**（卡片下拉/长按出现小锁），防止"一键清理"把它清掉
4. **开发者选项 → 关闭「暂停执行已缓存的应用」**
   等价命令（adb）：`settings put global cached_apps_freezer disabled`

有 adb 时可以自查：

```sh
adb shell settings get global cached_apps_freezer     # 期望 disabled
adb shell dumpsys activity processes | grep -n 'cached=' | head   # DSHA 不该是 cached
```

> （可选）USB 调试：只在你需要从电脑推离线包、抓日志时打开。日常运行不需要连电脑。

## 4. 在容器里装 Nest 本地世界

### 4.1 准备离线包

在仓库根目录：

```sh
node scripts/make-offline-package.mjs     # 生成 dist/nest-offline.tar.gz
adb push dist/nest-offline.tar.gz /sdcard/Download/nest/nest-offline.tar.gz
```

### 4.2 首次安装

把离线包推到手机后，在 DSHA → 终端（或通过 DSH web）执行：

```sh
mkdir -p /root/nest-local
tar xzf /sdcard/Download/nest/nest-offline.tar.gz -C /root/nest-local
cd /root/nest-local
sh install-autostart.sh      # 写 start.sh + 装 DSH 启动钩子 + 立刻起一次服务
```

包里的四个脚本分工：

| 脚本 | 作用 |
|---|---|
| `install-autostart.sh` | 装钩子（写 `start.sh`，在 DSH 启动时拉起本地世界），并立刻验证 |
| `phone-start.sh` | 幂等启动：起 server(:8787) + bridge + watchdog（`install-autostart.sh` 会把它复制成 `start.sh`） |
| `watchdog.sh` | 每 60 秒探 8787，挂了自动重跑 `start.sh` |
| `deploy.sh` | 更新用：解压新离线包 → 重启 server/bridge → 打印状态码 |

装完目录长这样：

```
/root/nest-local/
├─ server/        Nest 服务（:8787）
├─ bridge/        nest-bridge.mjs（把消息喂给本机 DSH）+ nest-me.json（钥匙/身份）
├─ public/        前端
├─ data/          nest.db、media/、ai-key.txt、server.log、bridge.log、watchdog.log
├─ vendor/        js-yaml 等唯一第三方依赖
└─ start.sh       启动 server + bridge + watchdog
```

`start.sh` 干的四件事：设 `TZ=Asia/Shanghai` → nohup 起 server → nohup 起 bridge → 起 watchdog。

### 4.3 装自启动钩子（关键）

让「DSH 启动」自动拉起 Nest：

```sh
sh /root/nest-local/install-autostart.sh
```

它默认把钩子写进 DSH 启动时会 `--require` 的 `/usr/local/share/dsha/dns-compat.cjs`（追加 `NEST_LOCAL_AUTOSTART` 段，DSH 一起来就 spawn `/root/nest-local/start.sh`）；
如果那个文件不存在/不可写，就退回到给 `/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js` 注入 `NEST_AUTOSTART`（我们早期手工用的就是这个位置）。
效果（实测）：**重启 DSHA 后 20–40 秒**，`8787` 和 `3080` 都会自动就绪，不用手动跑 start.sh。

检查钩子还在不在（升级 DSHA 后必看）：

```sh
grep -c NEST_AUTOSTART /usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js
```

### 4.4 看门狗（已包含在 start.sh 里）

`watchdog.sh` 每 60 秒 `curl` 一次 `http://127.0.0.1:8787/api/server-info`，失败就记日志并重跑 `start.sh`。
实测：手动杀掉 server → **29 秒后自动恢复**。

### 4.5 账号与钥匙

- App 打开 `http://127.0.0.1:8787` → 注册第一个账号 = **主人**，再在「AI 管理」建一个 AI。
- bridge 的钥匙在 `data/ai-key.txt`，`start.sh` 每次启动自动读它；不要手动改。
- 记忆卡片、会话、媒体都在 `data/nest.db` 和 `data/media/`，**备份就备份整个 `data/`**。

### 4.6 日常更新

```sh
# 电脑上：重新打包并推到手机
node scripts/make-offline-package.mjs
adb push dist/nest-offline.tar.gz /sdcard/Download/nest/nest-offline.tar.gz

# 手机上（DSHA 终端）
sh /root/nest-local/deploy.sh
```

`deploy.sh` 会先备份 `data/nest.db`，再覆盖代码、重启 server/bridge、打印 8787 状态码；
`data/`（聊天、记忆、媒体、钥匙）不会被覆盖。

## 5. 验证清单

```sh
# 1) 两个端口
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/api/server-info   # 200
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3080/                   # 200/302

# 2) 三个进程都在
ps -ef | grep -E 'server/index.mjs|nest-bridge|watchdog.sh' | grep -v grep

# 3) 重启 DSHA 后（不碰任何东西）40 秒再看 8787 —— 应该自己回来（钩子）

# 4) 看门狗：杀掉 server，等 60 秒，8787 应该恢复
pkill -f server/index.mjs

# 5) App 里打开 127.0.0.1:8787，能登录、能聊天、AI 有回复
```

## 6. 排障表

| 症状 | 先看什么 | 处理 |
|---|---|---|
| App 显示"连不上"，`8787` 不监听 | 容器会话是否结束（DSHA 终端页显示"会话已结束"） | 打开 DSHA → 启动/重启；钩子会在 20–40 秒拉起 |
| `8787` 在监听但连不上、`ss` 显示 backlog 堆积 | 后台/锁屏冻结 | DSHA 省电模式关 + vivo 允许后台耗电 + `cached_apps_freezer=disabled`；改完重启 DSHA |
| 重启 DSHA 后世界不起 | 钩子是否还在（见 4.3） | 重跑 `install-autostart.sh` |
| 服务自己挂了但容器还在 | 看门狗日志 `data/watchdog.log` | 等 ≤60 秒自动恢复；看 `data/server.log` 崩溃栈 |
| 容器里时间差 8 小时 | `date` | 补 `/usr/share/zoneinfo/Asia/Shanghai`、`/etc/localtime`、`start.sh` 里 `export TZ=Asia/Shanghai`，重启服务 |
| AI 不回复 | `3080` 是否就绪、`data/bridge.log` | DSHA 启动页看 DSH 状态；重启 bridge |
| 电脑 8787 / 公网 ts.net 502 | 手机世界是否活着、是否同一 Wi-Fi | 先修手机；再重启电脑上的 `scripts/supervise.mjs` |
| 图片被当坏图 / 动图变静态 | 上传 MIME、表情包裁剪路径 | 已在 v0.6.4+ 修复：按魔数纠正 MIME、动图不裁剪 |
| 记忆写了没落库 | `data/bridge.log` 里有没有 `HTTP 404` | v0.7.1 已修（地址漏 AI id）；老版本升级即可 |

## 7. Shizuku（可选，不是 Nest 的依赖）

- 是什么：让普通 App 获得 ADB 级权限的开源桥（[RikkaApps/Shizuku](https://github.com/RikkaApps/Shizuku)，Apache-2.0）。用户手册：https://shizuku.rikka.app/
- 什么时候需要：想让 **DSHA 的「设备能力授权」** 用 Shizuku（在容器里直接跑设备 shell、看系统信息、少插 USB）。
- 下载：Google Play（`moe.shizuku.privileged.api`）或 GitHub Releases。
- 启用：开发者选项 → 无线调试 → 配对（输入配对码）→ 启动 Shizuku；有 root 也可以直接 root 启动。
- DSHA 里授权：**设置 → 设备能力授权 → Shizuku → 授权**。
- 对 Nest 的影响：**没有**。Nest 的 server/bridge/watchdog 全在容器里跑，不需要 Shizuku；没有它也能正常聊天、记忆、发图。

## 8. 给 AI 的一键提示词（复制给能操作手机的助手）

```
帮我把这台手机装成 Nest 的本地世界服务器，按下面顺序做，每步做完告诉我结果：

1) 确认系统：Android 11+ / arm64；确认已装 DSHA（com.dsh.client）。
2) DSHA 设置：使用体验 → 省电模式关掉；接口与运行配置 → proot、Web 端口 3080；然后重启 DSHA。
3) 系统设置：电池 → 后台耗电管理 → DSHA 允许后台耗电；自启动允许 DSHA；最近任务锁定 DSHA；
   开发者选项关闭"暂停执行已缓存的应用"。
4) 等 DSHA 启动页显示"DSH 已就绪"，确认 3080 可访问。
5) 把 nest-offline.tar.gz 放到 /sdcard/Download/nest/，在容器里：
   cd /root/nest-local && tar xzf /sdcard/Download/nest/nest-offline.tar.gz -C /root/nest-local
   sh /root/nest-local/start.sh
   sh /root/nest-local/install-autostart.sh
6) 验证：curl 8787 和 3080 都是 200；ps 能看到 server、bridge、watchdog 三个进程；
   重启一次 DSHA，40 秒内 8787 自动恢复。
7) 最后报告：DSHA 版本、DSH 版本、Nest 版本、两个端口状态码、三个进程是否在。

约束：不要动 /root/nest-local/data（那是聊天和记忆数据）；不要卸载 DSHA；改任何系统设置前先说明。
```

## 9. 版本与升级

- 本机当前：DSHA `0.2.21-20261009.0750-dsh0.2.0-rc.2`（DSH 0.2.0-rc.2 / Ubuntu 10 / proot）、Nest `0.7.1`。
- 升级 DSHA：装新 APK（同包名，覆盖安装）→ 重跑 `install-autostart.sh` → 重启 DSHA → 按第 5 节验证。
- 升级 Nest：生成新离线包 → tar 覆盖 `/root/nest-local` → `sh /root/nest-local/start.sh`（`data/` 不受影响）。