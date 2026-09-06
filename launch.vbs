Option Explicit

Dim fso, nodePath, workDir, url, oShell, cmd, ready, waitCount

Set fso = CreateObject("Scripting.FileSystemObject")
workDir = fso.GetParentFolderName(WScript.ScriptFullName)
nodePath = fso.BuildPath(workDir, "runtime\node.exe")
If Not fso.FileExists(nodePath) Then nodePath = "node.exe"
url      = "http://127.0.0.1:4876"

Set oShell = CreateObject("WScript.Shell")
oShell.CurrentDirectory = workDir

Function RuntimeUrl()
  Dim markerPath, text, re, matches
  RuntimeUrl = "http://127.0.0.1:4876"
  markerPath = oShell.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\AgentBoard\.runtime.json"
  On Error Resume Next
  If fso.FileExists(markerPath) Then
    text = fso.OpenTextFile(markerPath, 1, False).ReadAll
    Set re = New RegExp
    re.Pattern = """port""\s*:\s*(\d+)"
    re.Global = False
    Set matches = re.Execute(text)
    If matches.Count > 0 Then RuntimeUrl = "http://127.0.0.1:" & matches(0).SubMatches(0)
  End If
  On Error GoTo 0
End Function

Function Ping()
  Dim h, ok
  ok = False
  On Error Resume Next
  Set h = CreateObject("MSXML2.XMLHTTP")
  ' 用 /api/health 而不是 /api/state：health 只回身份/扫描状态（<1KB），
  ' state 会回全量活跃会话快照（可能几百 KB），首屏探测没必要拉它。
  h.Open "GET", url & "/api/health", False
  h.Send
  If Err.Number = 0 Then
    If h.Status = 200 Then ok = True
  End If
  On Error GoTo 0
  Ping = ok
End Function

url = RuntimeUrl()
ready = Ping()
If Not ready Then
  cmd = Chr(34) & nodePath & Chr(34) & " " & Chr(34) & workDir & "\server.js" & Chr(34)
  oShell.Run cmd, 0, False
  url = RuntimeUrl()
  waitCount = 0
  Do While waitCount < 16 And Not Ping()
    WScript.Sleep 500
    waitCount = waitCount + 1
  Loop
End If

oShell.Run url
