@echo off
rem Stops the Streamline server (the one listening on port 4545).
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:"127.0.0.1:4545 .*LISTENING"') do (
  taskkill /PID %%p /F >nul 2>nul
  echo Streamline stopped.
  goto :done
)
echo Streamline was not running.
:done
timeout /t 2 >nul
