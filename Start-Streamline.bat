@echo off
rem Starts Streamline. The server runs in a minimized window (taskbar only) and your browser opens to it.
rem For no window at all use Start-Streamline.vbs. Messages are saved to data\server.log.
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install it from https://nodejs.org ^(LTS^) and try again.
  pause
  exit /b 1
)
if not exist data mkdir data
echo [%date% %time%] Start-Streamline.bat launched>> data\server.log
start "Streamline server" /min cmd /d /c "node server.js --open >> data\server.log 2>&1"
exit /b 0
