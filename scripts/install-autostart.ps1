# 注册开机自启：登录 Windows 后静默跑 scripts/supervise.mjs
#
# 用法（不用管理员权限：任务是"当前用户登录时"触发）：
#   powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
# 立刻试跑：
#   schtasks /Run /TN NestChatServer
# 卸载：
#   powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1 -Remove
#
# 为什么绕一层 wscript：
#   计划任务直接执行 node.exe 时，Windows 会为它开一个控制台窗口，
#   每次登录都弹黑框。scripts\launch-hidden.vbs 用 WScript.Shell.Run(cmd, 0, False)
#   启动 node，窗口样式 0 = 完全隐藏。
#
# 为什么是"登录时"而不是"开机时"：
#   DSH 和 node 都是用户态程序，开机时还没有用户会话，跑起来也连不上 DSH。

param(
  [switch]$Remove,
  [string]$TaskName = 'NestChatServer'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

if ($Remove) {
  schtasks /Delete /TN $TaskName /F 2>$null | Out-Null
  Write-Host "已删除计划任务：$TaskName"
  Write-Host "（正在跑的守护进程不会自动退出，需要的话用 data\_supervisor.pid 里的 PID 结束它）"
  return
}

$vbs = Join-Path $root 'scripts\launch-hidden.vbs'
$supervise = Join-Path $root 'scripts\supervise.mjs'
if (-not (Test-Path $vbs)) { throw "找不到 $vbs" }
if (-not (Test-Path $supervise)) { throw "找不到 $supervise" }

$wscript = Join-Path $env:WINDIR 'System32\wscript.exe'
if (-not (Test-Path $wscript)) { throw '找不到 wscript.exe（系统里应该有）' }

# 动作：wscript 静默拉起 VBS，VBS 再以隐藏窗口启动 node
$action = "`"$wscript`" //B //Nologo `"$vbs`""

schtasks /Create /TN $TaskName /TR $action /SC ONLOGON /RL LIMITED /F | Out-Null
if ($LASTEXITCODE -ne 0) { throw "注册失败（退出码 $LASTEXITCODE）" }

Write-Host "已注册计划任务：$TaskName"
Write-Host "  触发：当前用户登录时（静默，无控制台窗口）"
Write-Host "  动作：$action"
Write-Host "  日志：$root\data\_supervisor.log"
Write-Host ""
Write-Host "现在试跑一次：schtasks /Run /TN $TaskName"
Write-Host "查看任务：    schtasks /Query /TN $TaskName /V /FO LIST"
Write-Host "卸载：        powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1 -Remove"
