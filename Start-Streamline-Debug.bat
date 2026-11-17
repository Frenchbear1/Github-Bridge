@echo off
rem Troubleshooting only: starts Streamline in a visible window so you can read its messages.
rem For everyday use, double-click Start-Streamline.vbs instead (no window).
setlocal
title Streamline (debug)
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install it from https://nodejs.org and try again.
  pause
  exit /b 1
)
node server.js --open
pause
