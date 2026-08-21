Option Explicit

Dim nodePath, workDir, url, oShell, cmd, ready, waitCount

nodePath = "C:\Program Files\nodejs\node.exe"
workDir  = "C:\Users\Administrator\WorkBuddy\2026-08-20-03-52-10\agent-board"
url      = "http://127.0.0.1:4876"

Set oShell = CreateObject("WScript.Shell")

Function Ping()
  Dim h, ok
  ok = False
  On Error Resume Next
  Set h = CreateObject("MSXML2.XMLHTTP")
  h.Open "GET", url & "/api/state", False
  h.Send
  If Err.Number = 0 Then
    If h.Status = 200 Then ok = True
  End If
  On Error GoTo 0
  Ping = ok
End Function

ready = Ping()
If Not ready Then
  cmd = Chr(34) & nodePath & Chr(34) & " " & Chr(34) & workDir & "\server.js" & Chr(34)
  oShell.Run cmd, 0, False
  waitCount = 0
  Do While waitCount < 16 And Not Ping()
    WScript.Sleep 500
    waitCount = waitCount + 1
  Loop
End If

oShell.Run url