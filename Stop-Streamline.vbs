' Stops Streamline without opening any window. (The app also has a Quit button.)
Option Explicit
Dim http
On Error Resume Next
Set http = CreateObject("MSXML2.XMLHTTP")
http.Open "POST", "http://127.0.0.1:4545/api/quit", False
http.setRequestHeader "X-Streamline", "1"
http.Send
If Err.Number <> 0 Then
  MsgBox "Streamline is not running.", 64, "Streamline"
Else
  MsgBox "Streamline stopped.", 64, "Streamline"
End If
