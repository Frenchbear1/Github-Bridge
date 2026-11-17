@echo off
setlocal
title Streamline
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install it from https://nodejs.org ^(LTS^) and try again.
  pause
  exit /b 1
)
echo Starting Streamline... keep this window open while you use it. Close it to stop.
node server.js --open
pause
