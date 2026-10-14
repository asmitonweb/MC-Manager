#requires -Version 5.1

$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
Remove-ItemProperty -Path $runKey -Name 'MCManagerTray' -ErrorAction SilentlyContinue
foreach ($dir in @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))) {
    Remove-Item -LiteralPath (Join-Path $dir 'MC Manager.lnk') -ErrorAction SilentlyContinue
}
Write-Host 'MC Manager logon start and shortcuts removed.'
