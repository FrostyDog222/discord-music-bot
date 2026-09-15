' Runs watchdog.ps1 with NO window at all (avoids any console flicker every 5 min).
Dim fso, dir, sh
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = dir
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & dir & "\watchdog.ps1""", 0, False
