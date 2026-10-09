@echo off
setlocal
set "SCRIPT=%~dp0mc-manager-tray.ps1"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%SCRIPT%" %*
