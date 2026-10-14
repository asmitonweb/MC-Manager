Set shell = CreateObject("WScript.Shell")
scriptPath = Replace(WScript.ScriptFullName, "start-tray.vbs", "start-tray.cmd")
args = ""
For Each arg In WScript.Arguments
    args = args & " " & arg
Next
shell.Run """" & scriptPath & """" & args, 0, False
