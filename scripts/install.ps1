# Nest 一键安装（Windows）
#
# 做的事：
#   1. 检查 Node 版本（需要 22.5+）
#   2. 建好 data 目录
#   3. 生成 secrets（不需要；首次打开网页注册的第一个账号就是管理员）
#   4. 可选：注册开机自启（计划任务 NestChatServer）
#   5. 启动服务并打开浏览器
#
# 用法（在项目根目录）：
#   powershell -ExecutionPolicy Bypass -File scripts\install.ps1
#   参数：-NoStart 只装不启动   -Autostart 顺便设开机自启   -Tunnel 同时开公网

param(
  [switch]$NoStart,
  [switch]$Autostart,
  [switch]$Tunnel
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

function Write-Step($text) { Write-Host ""; Write-Host "== $text ==" -ForegroundColor Cyan }
function Write-Ok($text) { Write-Host "  [OK] $text" -ForegroundColor Green }
function Write-Warn($text) { Write-Host "  [!] $text" -ForegroundColor Yellow }

Write-Host @"
 __   _  _  ___  _____
|  \ | \| |/ __||_   _|   Nest · 自己的群，自己的人
| | || .  |\__ \  | |     一个只和 AI 聊天的聊天软件
|___/|_|\_||___/  |_|
"@ -ForegroundColor Cyan

# ---------- 1. Node ----------
Write-Step "检查 Node"
$node = $null
# 候选：环境变量 → 项目自带 → PATH → 常见安装位置（很多人装 Node 时不加 PATH）
$cands = @(
  $env:NEST_NODE,
  (Join-Path $root 'node.exe'),
  'node',
  'D:\nodejs\node.exe',
  (Join-Path $env:ProgramFiles "nodejs\node.exe"),
  (Join-Path ${env:ProgramFiles(x86)} "nodejs\node.exe"),
  (Join-Path $env:LOCALAPPDATA "Programs\nodejs\node.exe")
)
foreach ($cand in $cands) {
  if (-not $cand) { continue }
  try {
    $v = & $cand -v 2>$null
    if ($v -match '^v(\d+)\.(\d+)\.(\d+)$') {
      $major = [int]$Matches[1]; $minor = [int]$Matches[2]
      if ($major -gt 22 -or ($major -eq 22 -and $minor -ge 5)) {
        $node = $cand
        Write-Ok "Node $v（$cand）"
        break
      } else {
        Write-Warn "Node $v 版本太低，需要 22.5 以上"
      }
    }
  } catch { }
}
if (-not $node) {
  Write-Host "`n没找到可用的 Node 22.5+。" -ForegroundColor Red
  Write-Host "去 https://nodejs.org 下载 LTS 安装（一路下一步），装完重开这个脚本。" -ForegroundColor Yellow
  exit 1
}

# ---------- 2. 目录 ----------
Write-Step "准备目录"
New-Item -ItemType Directory -Force -Path (Join-Path $root 'data') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $root 'data\media') | Out-Null
Write-Ok "data\ 就绪（聊天记录都存在这里）"

# ---------- 3. 可选：开机自启 ----------
if ($Autostart) {
  Write-Step "设置开机自启"
  try {
    & (Join-Path $root 'scripts\install-autostart.ps1') 2>&1 | Out-Host
    Write-Ok "已注册计划任务 NestChatServer（登录后自动后台启动）"
  } catch {
    Write-Warn "自启设置失败：$($_.Exception.Message)"
  }
}

# ---------- 4. 启动 ----------
if (-not $NoStart) {
  Write-Step "启动 Nest"
  $port = if ($env:NEST_PORT) { [int]$env:NEST_PORT } else { 8787 }

  # 已经在跑就不重复启动
  $existing = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  if ($existing) {
    Write-Ok "端口 $port 已经在监听，说明服务已启动"
  } else {
    $superArgs = @('--no-warnings', (Join-Path $root 'scripts\supervise.mjs'))
    if ($Tunnel) { $superArgs += '--tunnel' }
    Start-Process -FilePath $node -ArgumentList $superArgs -WorkingDirectory $root -WindowStyle Hidden
    Write-Ok "已在后台启动（关掉这个窗口也不影响）"
    Start-Sleep -Seconds 6
  }

  Write-Step "打开浏览器"
  $url = "http://127.0.0.1:$port/"
  try {
    $r = Invoke-WebRequest "$url/api/server-info" -UseBasicParsing -TimeoutSec 6
    if ($r.StatusCode -eq 200) {
      $info = $r.Content | ConvertFrom-Json
      Write-Ok "服务正常：$url"
      if ($info.lan) { Write-Ok "同一局域网可以用：http://$($info.lan[0]):$port" }
      if ($info.publicUrl) { Write-Ok "公网地址：$($info.publicUrl)" }
      Start-Process $url
    }
  } catch {
    Write-Warn "服务还没起来，等几秒刷新 $url"
  }
}

Write-Host @"

下一步：
  1. 浏览器里点「注册」，建第一个账号（它会是管理员）
  2. 设置 → 我的 AI → 创建 AI，按向导生成一段口令
  3. 把口令发给要跑 AI 的那台电脑（不是服务器这台）

常用命令（在项目目录下）：
  npm run supervise        前台启动（看日志）
  npm run supervise:tunnel 启动并开公网
  npm run selftest         自检（127 项）
  npm run tunnel:restart   重启公网隧道

"@ -ForegroundColor Gray
