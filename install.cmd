@echo off
rem ── Nest 一键安装（双击我）──────────────────────────────
rem 需要 Node 22.5+：没装的话先到 https://nodejs.org 装 LTS
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo   Nest 安装程序
echo   ------------
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo   [!] 没找到 Node。请先去 https://nodejs.org 下载安装 LTS 版，装完再双击我。
  echo.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install.ps1" %*
echo.
pause
