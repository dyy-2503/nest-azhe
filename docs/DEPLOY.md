# 部署与运维

Nest 的目标是「拷过去就能跑」：没有构建步骤，没有原生模块，没有 node_modules 依赖。

## 环境要求

| 项 | 要求 | 说明 |
|---|---|---|
| Node | **22.5 或更新** | 数据库用的是 Node 内置的 `node:sqlite` |
| 系统 | Windows / macOS / Linux | 只用 Node 内置能力，没有平台特有代码 |
| 磁盘 | 空库 + 文字很少 | 20 人一年文字约 87MB；图片另算 |
| 端口 | 默认 8787 | 用 `NEST_PORT` 改 |

查版本：

```
node -v
```

## 启动

任选一种，效果一样：

```
# Windows：双击这个
start.cmd

# macOS / Linux
chmod +x start.sh && ./start.sh

# 都会走同一个入口
npm start
```

启动后终端会打印两个地址：

```
[nest] 本机   http://127.0.0.1:8787
[nest] 局域网 http://192.168.1.172:8787   ← 同学用这个
```

**只想自己用**（不给局域网开放）：

```
NEST_HOST=127.0.0.1 npm start        # macOS / Linux
set NEST_HOST=127.0.0.1 && npm start # Windows cmd
```

## 第一次使用

1. 打开页面 → 点「注册」
2. **第一个注册的账号自动成为管理员**（不写死用户名）
3. 管理员可以访问 `/admin` 看概览、管理邀请码

邀请码用于让别人注册：

- 管理台里生成，或者
- 自己的账号在设置里生成

## 数据在哪

```
data/nest.db          数据库（消息、用户、群）
data/media/           上传的图片/文件（内容寻址，文件名是 sha256）
data/backups/         备份
```

**备份就是复制 `data/` 目录**。别只复制 `nest.db`——图片在 `media/` 里。

## 备份与清理

```
npm run backup      # 只备份（SQLite 在线安全备份，保留最近 7 份）
npm run maintain    # 备份 + 清理过期会话、孤儿图片、野文件
npm run maintain -- --dry-run   # 只看会删什么，不动手
```

可调的环变量：

| 变量 | 默认 | 含义 |
|---|---|---|
| `NEST_BACKUP_KEEP` | 7 | 保留几份备份 |
| `NEST_MEDIA_TTL_DAYS` | 90 | 多久没被任何消息引用的图片算孤儿 |
| `NEST_SESSION_TTL_DAYS` | 60 | 多久没登录的会话失效 |

挂计划任务（每天凌晨）：

```
# Windows 任务计划程序：程序选 node，参数 scripts\maintain.mjs
# Linux/macOS crontab：
0 4 * * * cd /path/to/nest && node scripts/maintain.mjs >> data/maintain.log 2>&1
```

## 自测

改完代码想确认没弄坏：

```
npm run selftest
```

它会起一个**独立的临时服务**（8799 端口 + 临时数据库），把注册、登录、资料、AI 接入、好友、私聊权限、群管理、邀请码、权限边界全跑一遍，最后打印通过/失败数。**不会动你的正式数据**。

## AI 接入

每个 AI 成员在自己的机器上跑一个桥接进程：

```
node nest-bridge.mjs --server http://<服务器>:8787 --key NEST-AI-xxxx
```

- `--server` 指向 Nest 服务
- `--key` 在页面「我的 AI → 发钥匙」拿到（只显示一次）
- 桥接会自动找本机 DSH，也可以 `--dsh http://127.0.0.1:<端口>` 指定
- `--preset minimal` 能更快，但 AI 会没有工具（改不了自己的资料、看不了图）

AI 能做什么，由主人在资料页勾：记忆 / 情绪 / 主动说话 / 允许自己改名字。

## 跨平台注意

| 平台 | 情况 |
|---|---|
| Windows | 已验证。桥接建的 DSH 会话是 `workspace-write` 沙箱，**起不了终端**，所以 AI 改资料走标记协议而不是跑命令 |
| macOS / Linux | 未实测。代码里没有平台分支，但路径分隔符、进程信号等细节需要真机验证 |

## 目录结构

```
server/        服务端（index=路由, db=库, auth=鉴权, agent=内置AI回话, admin=管理台）
public/        前端（无构建，直接改直接生效）
bridge/        AI 桥接（独立进程，别人家机器上跑）
scripts/       启动器、自测、运维
docs/          决策记录与部署文档
data/          运行时数据（不要提交到 git）
```

---

## 语音消息

### 怎么录、怎么放

- **录**：聊天工具条的麦克风按钮**按住说话**，松手发送，往上滑 50px 取消。60 秒自动停止发送。
- **格式**：浏览器给什么录什么（Chrome/Edge/Android → `webm+opus`，Safari → `mp4/AAC`），**不转码**，原格式存、按真实 mime 下发。
- **波形**：录音时用 AnalyserNode 实时采 48 格峰值随消息存下来，播放端不用解码音频就能画。
- **播放**：点气泡播放/暂停；进度用消息里存的秒数算（Chrome 录的 webm 不写时长，`audio.duration` 是 Infinity）。

### 手机上录音必须先解决 HTTPS

浏览器只在**安全上下文**（HTTPS 或 `localhost`）里给麦克风。手机用 `http://192.168.x.x:8787` 打开时 `navigator.mediaDevices` 是 `undefined`。

三条路，按省事程度排：

**1) adb reverse（安卓，最省事，不用证书）**

```powershell
# 下载 platform-tools zip 解压，手机开 USB 调试后：
adb devices
adb reverse tcp:8787 tcp:8787
```

然后手机浏览器打开 **`http://localhost:8787`** —— `localhost` 是安全上下文，麦克风直接可用。电脑上 `edge://inspect` 还能看手机 console。

**2) 自签证书（任何手机都能用，但要装证书）**

Windows 生成一份，导出 PFX 给 Node 用：

```powershell
$ip = '192.168.1.172'
$cert = New-SelfSignedCertificate -DnsName 'localhost', $ip -CertStoreLocation Cert:\CurrentUser\My `
  -KeyUsage DigitalSignature, KeyEncipherment -KeyExportPolicy Exportable -NotAfter (Get-Date).AddYears(3)
# 导出 PFX（Node 直接吃）
$pw = ConvertTo-SecureString -String 'nest' -Force -AsPlainText
Export-PfxCertificate -Cert $cert -FilePath data\nest.pfx -Password $pw
# 再导出 .cer 给手机安装（安卓：设置→安全→从存储安装→CA 证书）
Export-Certificate -Cert $cert -FilePath data\nest.cer
```

启动：

```powershell
$env:NEST_TLS_PFX='D:\qq-ai\chat\data\nest.pfx'; $env:NEST_TLS_PASS='nest'; npm start
```

也支持 PEM：`NEST_TLS_CERT` + `NEST_TLS_KEY`。macOS/Linux 用 `mkcert` 更省事。

**3) 只在电脑上用**：`http://localhost:8787` 本身就是安全上下文，不用证书。

### AI 能"听"懂语音

桥接收到语音后：下载 → **ffmpeg 转 16kHz 单声道 PCM16 WAV** → 调 DSH 本地离线转写（SenseVoice）→ 把文字给 AI。

```js
// 桥接里的关键一步：ffmpeg 必须加 bitexact，否则会在 fmt 和 data 之间插 LIST 块，
// DSH 的转写接口只收"规范布局"的 WAV，会直接拒：Audio must be a canonical 16 kHz mono PCM16 WAV
'-ar','16000','-ac','1','-c:a','pcm_s16le','-f','wav','-fflags','+bitexact','-flags','+bitexact','-map_metadata','-1'
```

要求与限制：

| 项 | 值 |
|---|---|
| 格式 | 16 kHz / 单声道 / PCM16 WAV（桥接自动转） |
| 大小 | ≤ 4 MiB（约 2 分钟）|
| 时长 | ≤ 120 秒 |
| 可用性 | 需要 DSH profile 装了 `speech-to-text` 系列插件（desktop 默认有）；没有就降级成"AI 听不见，请对方打字" |
| ffmpeg | 默认从 PATH 找，也可以 `--ffmpeg D:\path\to\ffmpeg.exe` 指定 |

## 移动端注意（踩过的坑）

| 坑 | 处理 |
|---|---|
| iOS 键盘弹起时输入条被盖住 | `visualViewport` 算出键盘高度写进 `--kb`，输入条/浮层跟着抬 |
| 刘海屏 / home 条压内容 | `env(safe-area-inset-*)` |
| 长按弹系统菜单/放大镜 | 消息节点 `-webkit-touch-callout:none` + 自己 480ms 长按 |
| 双击放大 | 可点元素 `touch-action: manipulation` |
| 点一下出灰块 | `-webkit-tap-highlight-color: transparent` |
| iOS 输入框字号 <16px 会整页放大 | 输入框 16px |
| 页面橡皮筋 | `overscroll-behavior: none` |

---

## 守护进程（服务别再手动拉了）

DSH 一重启，它派生的子进程会被一起带走；DSH 的端口每次启动还会变。所以 Nest 自带一个守护进程：

```powershell
npm run supervise          # 前台跑，能看日志
node scripts/supervise.mjs --daemon   # 后台跑（开机自启就用这个）
```

它做的事：
1. 启动前用 `scripts/lib/dsh.mjs` **自己找到本机 DSH**（靠那句 401 指纹，不靠写死端口）
2. 拉起 `server/index.mjs` 和 `bridge/nest-bridge.mjs`
3. 谁挂了就重启谁（1s → 2s → 4s… 最多 30s 退避）；活过 30 秒算稳定，退避清零
4. 日志：`data/_supervisor.log`

服务端自己也有一层：启动时和每 60 秒巡检一次 DSH，端口变了自动改 `DSH_WEB_URL`，不用重启。

### 开机自启（需要手动注册一次）

```powershell
# 注册（当前用户登录时启动，不需要管理员）
powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
# 立刻试跑
schtasks /Run /TN NestChatServer
# 卸载
powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1 -Remove
```

## 全局搜索（Ctrl+K）

- 点侧栏搜索框，或按 **Ctrl/Cmd+K**，在**所有会话**里搜消息
- 结果带会话名、发送人、时间、命中片段高亮
- 点结果 → 切到那个会话 → 自动往前翻页把那条消息找出来并闪一下
- 只搜自己参与的会话；自己隐藏过的消息搜不到

## 语音转文字（人也能看）

语音气泡上右键/长按 → **转文字**。

- 走本机 DSH 的离线 SenseVoice（跟 AI 听到的是同一套）
- 第一次约 0.5–1 秒（模型热了之后），结果按音频 sha 缓存，重复点秒回
- 老格式（没音频文件的占位语音）会明确提示"转不了"

## 表情管理

「我的表情」里每个表情 hover 出现 **×**，点掉即删。

---

## 开机自启（已在本机注册，2026-11-22）

```powershell
# 注册（当前用户登录时触发，不要管理员）
powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
# 立刻试跑
schtasks /Run /TN NestChatServer
# 看状态
schtasks /Query /TN NestChatServer /V /FO LIST
# 卸载
powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1 -Remove
```

**不弹黑框的做法**：计划任务不直接执行 node（那样 Windows 会开一个控制台窗口），
而是执行 `wscript.exe //B scripts\launch-hidden.vbs`，VBS 里用
`WScript.Shell.Run(cmd, 0, False)` 以窗口样式 0（隐藏）启动 node。

**单实例**：`scripts/supervise.mjs` 启动时写 `data/_supervisor.pid` 并检查旧 PID 是否还活着，
开机自启和手动启动撞上时后者直接退出，不会两个服务抢 8787。

**已验证**：杀掉守护进程和所有子进程 → `schtasks /Run` → 服务端 + 桥接全部自动回来（HTTP 200）。

### ps1 文件要有 BOM

Windows PowerShell 5.1（`powershell.exe`）读没有 BOM 的 `.ps1` 会按 GBK 解析，
中文注释和字符串直接乱码、报语法错。改脚本后如果中文报错，补 BOM：

```powershell
$p = 'scripts\install-autostart.ps1'
$t = [IO.File]::ReadAllText($p, [Text.Encoding]::UTF8)
[IO.File]::WriteAllText($p, $t, [Text.UTF8Encoding]::new($true))
```

同理 `.vbs` 请保持纯 ASCII（没有 BOM 概念），中文只放日志文件里。
