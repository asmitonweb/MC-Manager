Set shell = CreateObject("WScript.Shell")
scriptPath = Replace(WScript.ScriptFullName, "start-tray.vbs", "start-tray.cmd")
shell.Run """" & scriptPath & """", 0, False
