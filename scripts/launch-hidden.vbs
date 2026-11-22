' Nest 静默启动器（给计划任务 / 安装脚本用）
'
' 为什么是 VBS：如果让计划任务直接跑 node.exe，Windows 会弹一个黑色控制台窗口，
' 每次登录都闪一下。WScript.Shell.Run 用 0 号窗口样式启动，完全看不见。
'
' 参数：
'   --daemon   后台常驻（不带就是前台跑，关掉窗口就停）
'   --tunnel   同时开公网访问（Tailscale Funnel / SSH 隧道）
'
' 这个文件不写死任何路径：Node 从 %NEST_NODE% → 项目内 node.exe → PATH 里找。

Option Explicit

Dim shell, fso, root, node, script, cmd, args, i

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' 本文件在 <项目>\scripts\ 下，项目根是它的上一级
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
script = root & "\scripts\supervise.mjs"

' 收集转发给守护进程的参数
args = ""
For i = 0 To WScript.Arguments.Count - 1
  args = args & " " & WScript.Arguments(i)
Next

' 找 Node：① 环境变量 ② 项目自带 ③ PATH
node = shell.ExpandEnvironmentStrings("%NEST_NODE%")
If node = "%NEST_NODE%" Then node = ""
If node = "" Then
  If fso.FileExists(root & "\node.exe") Then
    node = root & "\node.exe"
  End If
End If
If node = "" Then
  On Error Resume Next
  Dim exec, out
  Set exec = shell.Exec("cmd /c where node 2>nul")
  If Err.Number = 0 Then
    out = exec.StdOut.ReadAll
    If Len(Trim(out)) > 0 Then node = Split(Trim(Split(out, vbCrLf)(0)), vbCrLf)(0)
  End If
  On Error GoTo 0
End If
If node = "" Then
  ' 最后的兜底：常见安装位置
  If fso.FileExists(shell.ExpandEnvironmentStrings("%ProgramFiles%") & "\nodejs\node.exe") Then
    node = shell.ExpandEnvironmentStrings("%ProgramFiles%") & "\nodejs\node.exe"
  Else
    node = "node.exe"
  End If
End If

If Not fso.FileExists(script) Then
  Dim trace
  Set trace = fso.CreateTextFile(root & "\data\_autostart-error.txt", True)
  trace.WriteLine "找不到 " & script
  trace.WriteLine "请确认这是一个完整的 Nest 目录"
  trace.Close
  WScript.Quit 1
End If

cmd = """" & node & """ """ & script & """" & args

' 0 = 隐藏窗口，False = 不等待
shell.Run cmd, 0, False
