#requires -Version 5.1

$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
Remove-ItemProperty -Path $runKey -Name 'MCManagerTray' -ErrorAction SilentlyContinue
Write-Host 'MC Manager tray startup entry removed.'
