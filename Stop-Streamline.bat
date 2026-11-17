@echo off
rem Stops Streamline (same as the Quit button in the app).
start "" wscript.exe "%~dp0Stop-Streamline.vbs"
exit /b 0
