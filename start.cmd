@echo off
rem ── 启动 Nest（双击我）────────────────────────────────
rem 后台常驻；要开公网访问就用 install.cmd -Tunnel，或 npm run supervise:tunnel
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo   [!] 没找到 Node。请先运行 install.cmd。
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install.ps1" -NoStart:$false %*
timeout /t 3 >nul
