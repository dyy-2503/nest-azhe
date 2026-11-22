# 远程访问（让朋友在外网也能跟你的 AI 聊）

## 一句话

```
npm run supervise:tunnel
```

跑起来之后，设置浮层里「远程地址」会显示一个 `https://xxx.serveousercontent.com`，
点一下复制发给朋友，他打开就能注册（要邀请码）、加你的 AI、聊天。

## 为什么用 SSH 反向隧道

这台机器从 GitHub 拉 cloudflared（约 30MB）非常慢，而：

- Windows 自带 OpenSSH
- serveo / localhost.run 提供**免注册**的 SSH 反向隧道
- 零下载、零账号，`ssh -R 80:127.0.0.1:8787 serveo@serveo.net` 就有一条公网 https

所以当前的实现是 SSH 隧道。以后要换成更稳的方案，只要在 `scripts/tunnel.mjs`
的 `PROVIDERS` 里加一个 provider（或者加一个 cloudflared 分支）即可。

## 启动方式

| 命令 | 作用 |
|---|---|
| `npm run supervise:tunnel` | 守护进程 + 服务端 + 桥接 + 隧道（推荐） |
| `npm run tunnel` | 只起隧道（服务端已经在跑时用） |
| `npm run tunnel -- --provider lhr` | 换 localhost.run |

隧道断了会自动重连（2s 起，最长 30s），**重连后地址可能变**，
设置里的「远程地址」每 30 秒刷新一次，变了会显示新地址。

## 安全模型（对公网暴露后必须知道的）

| 项目 | 做法 |
|---|---|
| **注册** | 隧道模式下自动切 `invite`：没有邀请码注册不了 |
| **邀请码** | 管理台 `/admin`（管理员账号）→「邀请码」→「生成一个」，一码一用，用后标记已用 |
| **Cookie** | 走 https 时自动加 `Secure`（局域网 http 下不加，否则存不上） |
| **登录限流** | 同一 IP 10 分钟内最多 40 次登录 / 10 次注册 / 20 次找回 |
| **管理台限流** | 同一 IP 10 分钟内最多 10 次试密码 |
| **AI 私聊** | 朋友加你的 AI 要**你点同意**（`好友请求` 收件箱里能看到"发给我的 + 发给我名下 AI 的"） |
| **真人↔真人** | 依旧禁止（`human_dm_blocked`），这片只做人↔AI |

## 会有什么坑

1. **地址会变**：serveo 免费版每次重连换子域名。要稳定地址需要：
   - 注册 serveo 账号 + 上传 SSH 公钥（免费，可固定名字）
   - 或者用自己的域名 + Cloudflare 具名隧道
   - 或者有公网服务器就用 frp
2. **中间提示页**：serveo 免费版 Pro 才去掉；实测用浏览器 UA 访问是直接进 Nest（没有提示页）。
3. **速度**：数据要绕 serveo 的服务器一圈，比局域网慢。发图/语音会慢一些。
4. **手机录音**：公网是 https，满足浏览器的安全上下文要求，**手机上远程也能按住说话**（局域网 http 反而不行）。
5. **服务停就断**：隧道跟着守护进程走，关掉电脑就没了。

## 不需要 VPN

- 朋友访问走 Cloudflare/serveo 的公网节点，**他们不需要 VPN**
- 你这台机器建隧道时也不需要 VPN（SSH 是主动外连）

## 数据在哪

- 隧道状态：`data/_tunnel.json`（界面读它显示地址）
- 隧道日志：`data/_tunnel.log`
- 服务端日志：`data/_supervisor.log`

## 固定地址（当前还需要你点一下）

serveo 的规则：想要固定子域名（`xxx.serveo.net`），得先把这台机器的 SSH 公钥登记到它的控制台
（用 Google 或 GitHub 账号登录即可，免费）。

**登记链接**（公钥已经填好了，直接点开登录就行）：

```
https://console.serveo.net/ssh/keys?add=SHA256%3AAnsEeQ0Fg8tA38ZQwE5nWgvjG2LEBgguG%2Fpah3f3LBY
```

登记完之后这样启动，地址就固定成 `https://nest2026.serveo.net`：

```powershell
$env:NEST_TUNNEL_NAME = 'nest2026'     # 想叫什么名字自己定
npm run supervise:tunnel
```

（不登记也能用，只是每次重连地址会变。）

## 邀请码怎么发给朋友

设置浮层 →「邀请码」→「＋ 生成一个新邀请码」→「复制」，把码发给朋友。
朋友在公网地址点「注册」，第一个框填这个码。

<!-- 补充说明：邀请码一码一用，用掉就失效；AI 成员不需要邀请码，走钥匙。 -->

## 关于"固定地址"的现状（2026-11-22）

- **serveo**：公钥已登记（Google/GitHub 登录完成），固定名 `nest-azhe` 已写进 `data\_tunnel_name.txt`。
  但当天我频繁重启测试把 serveo 弄限流了，它开始对所有转发端口返回
  `remote port forwarding failed for listen port 80`。通常过一段时间（几十分钟）会自己恢复。
- **localhost.run**：当前在用，能用，但免费版**地址会周期性轮换**。
  想要长期固定，同样需要注册账号并加 SSH 公钥：https://localhost.run/docs/forever-free/

### 当前的自动行为

`scripts/tunnel.mjs` 会：

1. 先试 `data\_tunnel_provider.txt` 里上次成功的 provider
2. 连续失败 2 次自动换下一个（serveo ⇄ lhr）
3. 固定名拿不到时先降级成随机地址保证在线，过 3 分钟再自动抢回固定名
4. 地址就绪后写进 `data\_tunnel.json`，界面每 30 秒刷新一次

### 想换固定名字

```powershell
notepad data\_tunnel_name.txt    # 改里面的名字，保存
# 重启服务让隧道重新读
```

名字要唯一，被占用时会自动降级并稍后重试。

## 稳定地址（已完成）

已登记 serveo 公钥，固定名写在 `data\_tunnel_name.txt`：

```
https://nest-azhe.serveousercontent.com
```

- 想换名字：改 `data\_tunnel_name.txt` → `npm run tunnel:restart`
- 重启服务后：serveo 会把名字占住几分钟，这段时间先用随机地址顶着，
  **最多 5 分钟会自动抢回固定名**（日志里能看到「固定地址 ✓」）
- 维护用优雅重启，不会换地址：`npm run tunnel:restart`

## 两个隧道方案的真实对比（实测，2026-11-22）

| | serveo | localhost.run |
|---|---|---|
| 朋友打开 | ❌ 先弹英文 **Browser Warning**（要手动点 Continue） | ✅ 直接进 Nest |
| 地址 | ✅ 可固定 `nest-azhe.serveousercontent.com` | ❌ 每次重连换一个 |
| 注册 | 已登记公钥 | 未登记（需再登一次） |
| 限流 | 频繁重连会临时拒绝所有转发 | 较宽松 |

**当前默认走 localhost.run**（朋友体验优先），地址在 `data/_tunnel.json`，
界面设置里「远程地址」显示的就是它。

### 想要"既固定又没警告页"

需要把 localhost.run 的公钥也登记一下（免费方案 "forever-free"）：

1. https://admin.localhost.run/ 用 GitHub/Google 登录
2. 添加本机公钥（`C:\Users\<你>\.ssh\id_ed25519.pub`）
3. 之后用 `ssh -R <你的名字>:80:127.0.0.1:8787 plan@localhost.run`

登记完告诉我，我把隧道改成这条路，地址就固定且没有警告页。

## 最终方案：Tailscale Funnel（2026-11-22 定稿）

前两家免费方案都试过，各有硬伤：

| 方案 | 地址 | 警告页 | 限速 |
|---|---|---|---|
| serveo 免费 | 固定 | ❌ 英文警告页 | 一般 |
| localhost.run 免费 | 会轮换 | 干净 | ❌ 会限速 |
| **Tailscale Funnel** | **固定** | **干净** | **不限速** |

### 现在的公网地址

```
https://nest-azhe.tailc3c676.ts.net
```

- 由 `tailscaled` 提供，指向 `127.0.0.1:8787`
- 开机自动恢复（Tailscale 服务 + `tailscale funnel --bg` 的配置都持久化）
- 朋友不需要装任何东西，直接打开

### 怎么维护

```powershell
# 看 Funnel 状态
& 'C:\Program Files\Tailscale\tailscale.exe' funnel status

# 重新指向（一般不用手动跑，隧道进程会自动补）
& 'C:\Program Files\Tailscale\tailscale.exe' funnel --bg 8787

# 换公网机器名（会换域名）
& 'C:\Program Files\Tailscale\tailscale.exe' up --hostname 新名字
```

隧道进程（`scripts/tunnel.mjs`）现在把 `ts` 作为首选 provider：
启动时检查 Funnel 是否指向 8787，不是就自己补上；每 60 秒复查一次。
`data/_tunnel.json` 里的 `url` 就是界面「远程地址」显示的内容。

### 依赖

- 这台电脑上的 Tailscale 服务必须运行（`Get-Service Tailscale`）
- 你的 Tailscale 账号在这个 tailnet 里有效
- Funnel 已在管理台启用（一次性操作）
