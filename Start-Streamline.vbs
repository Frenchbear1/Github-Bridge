' Starts Streamline with NO console window and opens it in your browser.
' Double-click this file. Closing the browser tab stops Streamline (or run Stop-Streamline.vbs).
Option Explicit
Dim sh, fso, dir, rc, log
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir

rc = sh.Run("cmd /c where node >nul 2>nul", 0, True)
If rc <> 0 Then
  MsgBox "Node.js was not found." & vbCrLf & vbCrLf & "Install it from https://nodejs.org (LTS version), then open Streamline again.", 48, "Streamline"
  WScript.Quit 1
End If

If Not fso.FolderExists(dir & "\data") Then fso.CreateFolder dir & "\data"
log = dir & "\data\server.log"
If fso.FileExists(log) Then
  If fso.GetFile(log).Size > 1048576 Then fso.DeleteFile log
End If

' Window style 0 = hidden. Output goes to data\server.log for troubleshooting.
sh.Run "cmd /c node server.js --open --autoquit >> ""data\server.log"" 2>&1", 0, False
