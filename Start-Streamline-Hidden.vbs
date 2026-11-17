' Starts Streamline with no console window and opens it in your browser.
' Stop it later with Stop-Streamline.bat.
Dim sh, dir
Set sh = CreateObject("WScript.Shell")
dir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
sh.Run "cmd /c node server.js --open", 0, False
