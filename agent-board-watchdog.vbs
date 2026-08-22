Option Explicit
' Agent Board 常驻看门狗：每 30 秒 Ping 一次 4876，挂了就自动拉起 node server.js（隐藏窗口）
' 随登录启动（Startup 文件夹），循环守护，解决"看板经常无法访问"的问题。
' 如需停止：任务管理器结束 wscript.exe 进程即可（或注销重新登录前先删除本文件）。

Dim nodePath, workDir, url, oShell, cmd, ready, failCount

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

' 主循环：持续守护
failCount = 0
Do While True
  If Ping() Then
    failCount = 0
  Else
    failCount = failCount + 1
    ' 连续 2 次 Ping 失败才重启（Ping 本身偶尔超时，避免误杀/重复拉起）
    If failCount >= 2 Then
      cmd = Chr(34) & nodePath & Chr(34) & " " & Chr(34) & workDir & "\server.js" & Chr(34)
      On Error Resume Next
      oShell.Run cmd, 0, False
      On Error GoTo 0
      ' 等待 server 起来（最多 20 秒）
      Dim n
      n = 0
      Do While n < 40 And Not Ping()
        WScript.Sleep 500
        n = n + 1
      Loop
      failCount = 0
    End If
  End If
  WScript.Sleep 30000
Loop
