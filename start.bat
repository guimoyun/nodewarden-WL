@echo off
rem NodeWarden Local - Windows quick start
rem 请把本文件与 nodewarden.exe、dist 文件夹放在同一目录
setlocal
cd /d "%~dp0"

if not defined JWT_SECRET (
  if exist .env (
    for /f "usebackq tokens=1,* delims==" %%a in (".env") do if "%%a"=="JWT_SECRET" set "JWT_SECRET=%%b"
  )
)

if not defined JWT_SECRET (
  set "JWT_SECRET=%RANDOM%%RANDOM%%RANDOM%%RANDOM%%RANDOM%%RANDOM%%RANDOM%%RANDOM%"
  echo JWT_SECRET=%JWT_SECRET%> .env
  echo [nodewarden] 已生成随机 JWT_SECRET 并保存到 .env，请妥善保管
)

echo [nodewarden] 启动中 ... 浏览器访问 http://127.0.0.1:8787
nodewarden.exe
pause
