@echo off
rem Starts Streamline with no lasting window (hands off to Start-Streamline.vbs). A console may blink for a split second.
start "" wscript.exe "%~dp0Start-Streamline.vbs"
exit /b 0
